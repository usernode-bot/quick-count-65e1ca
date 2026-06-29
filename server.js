// Quick Count — standalone usernode-dapp-starter server.
//
// A plain Node/Express server. The chain is the source of truth: every state
// change is an on-chain transaction carrying an app:"quickcount" memo. A
// deterministic indexer (lib/indexer.js) replays the transaction log to build
// all read state, so the server itself never mutates election data — it only
// reads the chain and serves the UI. Identity is the wallet address.
//
// Two run modes:
//   • production  — polls a Usernode node at NODE_RPC_URL.
//   • --local-dev — uses an in-process mock ledger + /__mock/* endpoints so the
//     whole app runs offline. The mock wallet bridge signs against it.
//
// Persistence is optional: with DATABASE_URL set the raw transaction log is
// stored in `chain_txs` (durable across restarts); without it the log lives in
// memory only. Either way the read model is rebuilt from the log on every poll.

try { require('dotenv').config(); } catch { /* dotenv optional */ }

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const { normalizeTx, QuickCountIndexer } = require('./lib/indexer');
const memo = require('./lib/memo');
const mock = require('./lib/mockledger');
const { makeSource, getTransaction, resolveTxEndpoint, postTransactions } = require('./lib/txsource');
const { verifyPayment } = require('./lib/unlock');
const { isKind, validateImageUpload, validateBallotProof } = require('./lib/attach');
const { isValidDisplayName, isValidBio, isSupportedLang } = require('./lib/profile');

let Pool = null;
try { ({ Pool } = require('pg')); } catch { /* pg optional in pure-memory mode */ }

// ── Configuration ───────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes('--local-dev') || process.env.APP_MODE === 'local-dev';
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const IS_DEMO = LOCAL_DEV || IS_STAGING; // seed obviously-fake data so every screen renders
// Always-on local-ingest ("mock") transaction flow. When true (the default in
// EVERY environment), submissions are ingested directly into the event log via
// /__mock/submit → ingestRaw → rebuild, with NO dependence on NODE_RPC_URL /
// EXPLORER_API_URL / chain polling / chain read-back. Kept deliberately separate
// from LOCAL_DEV and IS_DEMO so the developer-only affordances (persona switcher,
// `viewer` identity override, demo seeding) stay gated on those and are NOT
// enabled in staging/production. Set MOCK_TX_FLOW=false to restore real-chain reads.
const MOCK_TX_FLOW = process.env.MOCK_TX_FLOW !== 'false';
const PORT = process.env.PORT || 3000;
const NODE_RPC_URL = process.env.NODE_RPC_URL || '';
// Canonical chain read path: the public block explorer, addressed per-chain as
// <EXPLORER_API_URL>/<CHAIN_ID>/transactions. NODE_RPC_URL is the standalone
// fallback (used only when no explorer base is configured). The client polls
// the SAME explorer through the relative, auth-exempt /explorer-api/ prefix.
const EXPLORER_API_URL = process.env.EXPLORER_API_URL || '';
const CHAIN_ID = process.env.CHAIN_ID || 'usernode';
// Relative path the browser uses to reach the explorer proxy (auth-exempt via
// PUBLIC_PREFIXES). The bridge polls <EXPLORER_API_BASE>/<chain>/transactions.
const EXPLORER_API_BASE = '/explorer-api';
const TREASURY_ADDR = process.env.TREASURY_ADDR || 'ut1treasuryquickcount00000000000000000000';
const ORG_FEE = Number(process.env.ORG_FEE) || 100;
// The application's own on-chain identity. APP_PUBKEY is a public ut1… address
// (safe to surface); APP_SECRET_KEY is signing material — read defensively and
// NEVER logged or returned by any endpoint. No server-side signing path uses
// the secret yet; it is declared so operators can populate it in Settings →
// Secrets now and it is reserved for future app-signed operations.
const APP_PUBKEY = process.env.APP_PUBKEY || '';
const APP_SECRET_KEY = process.env.APP_SECRET_KEY || '';
// Poll / auto-refresh cadence (ms). Floored at 1000 so a stray small value
// can't hammer the chain read source or the client. Surfaced to the SPA via
// /__quickcount/config so the browser auto-refresh uses the same interval.
const TIMER_DURATION_MS = Math.max(1000, Number(process.env.TIMER_DURATION_MS) || 6000);

// Demo personas (local-dev persona switcher + admin).
const DEMO = {
  admin: 'ut1demoadmin000000000000000000000000000000',
  orgA: 'ut1democitizenscount0000000000000000000000',
  orgB: 'ut1demounpaidorg000000000000000000000000000',
  orgC: 'ut1demoprivateorg00000000000000000000000000', // private org
  orgD: 'ut1demodeletedorg00000000000000000000000000', // tombstoned org
  orgID: 'ut1demopemiluwatchid00000000000000000000000', // Pilpres 2024 (Indonesia) demo org
  pollwatch: 'ut1demopollwatchalliance00000000000000000000',
  obs1: 'ut1demoobserverone000000000000000000000000',
  obs2: 'ut1demoobservertwo000000000000000000000000',
  obs3: 'ut1demoobserverthree00000000000000000000000',
  orgAdmin: 'ut1demoorgadmin0000000000000000000000000000',
  orgMod: 'ut1demoorgmod000000000000000000000000000000',
  orgMember: 'ut1demoorgmember00000000000000000000000000',
};
const ADMIN_ADDRS = (process.env.ADMIN_ADDRS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (IS_DEMO) ADMIN_ADDRS.push(DEMO.admin);

const pool = (Pool && process.env.DATABASE_URL)
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const indexer = new QuickCountIndexer({ treasury: TREASURY_ADDR, orgFee: ORG_FEE, adminAddrs: ADMIN_ADDRS });
const source = makeSource({ localDev: LOCAL_DEV, nodeUrl: NODE_RPC_URL, explorerUrl: EXPLORER_API_URL, chainId: CHAIN_ID });

// In-memory transaction log (source for every rebuild) and dedupe set.
const txLog = [];
const seen = new Set();
const watched = new Map(); // address -> cursor
watched.set(TREASURY_ADDR, null);

// ── Live publishing (Server-Sent Events) ─────────────────────────────────────
// A tiny in-process pub/sub so an authorized change (a new station count, a
// vote-resolved dispute, a saved working tally, a finalized ballot proof) pushes
// to the public view instantly instead of waiting for the next poll. One-way
// server→client; clients re-fetch through the existing pay-to-unlock-aware
// endpoints, so the lock gate / visibility rules are unchanged — the event only
// carries { eid, kind, lastUpdated }, never vote figures.
const sseClients = new Map(); // eid -> Set<res>
let sseCount = 0;
const SSE_MAX = 500;
function sseSubscribe(eid, res) {
  if (!sseClients.has(eid)) sseClients.set(eid, new Set());
  sseClients.get(eid).add(res);
  sseCount++;
  return () => {
    const set = sseClients.get(eid);
    if (set) { set.delete(res); if (!set.size) sseClients.delete(eid); }
    sseCount = Math.max(0, sseCount - 1);
  };
}
function ssePublish(eid, payload) {
  const set = sseClients.get(eid);
  if (!set || !set.size) return;
  const frame = `event: update\ndata: ${JSON.stringify(payload || {})}\n\n`;
  for (const res of set) { try { res.write(frame); } catch { /* dropped on next write */ } }
}
function electionLastUpdated(eid) {
  try {
    const results = indexer.results.get(eid) || [];
    let last = null;
    for (const r of results) if (r.createdAt && (!last || r.createdAt > last)) last = r.createdAt;
    return last;
  } catch { return null; }
}
// A cheap per-election signature so pollOnce can tell which elections actually
// changed (new/updated result, vote-resolved dispute, structural change) and
// push only those. Covers the vote-approved case: an upheld `dres` flips a
// result's `invalid`/`disputed` flags, which the signature captures.
function electionSignatures() {
  const m = new Map();
  for (const eid of indexer.elections.keys()) {
    const results = indexer.results.get(eid) || [];
    const disputes = indexer.disputes.get(eid) || [];
    let sig = 'c' + (indexer.candidates.get(eid) || new Map()).size
      + 's' + (indexer.stations.get(eid) || new Map()).size
      + 'o' + (indexer.observers.get(eid) || new Map()).size + '|';
    for (const r of results) sig += r.txId + (r.invalid ? 'x' : '') + (r.disputed ? 'd' : '') + ';';
    sig += '|';
    for (const d of disputes) sig += d.txId + d.status + ';';
    m.set(eid, sig);
  }
  return m;
}

// ── Ingest / rebuild ─────────────────────────────────────────────────────────
function ingestRaw(raw) {
  const n = normalizeTx(raw);
  if (!n.txId || seen.has(n.txId)) return false;
  seen.add(n.txId);
  txLog.push(n);
  if (pool) {
    pool.query(
      `INSERT INTO chain_txs (tx_id, from_addr, to_addr, amount, memo, created_at, seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,NOW()) ON CONFLICT (tx_id) DO NOTHING`,
      [n.txId, n.from, n.to, n.amount, n.memo, n.createdAt]
    ).catch((e) => console.error('persist failed:', e.message));
  }
  return true;
}

function rebuild() {
  indexer.rebuild(txLog);
  // Discover org wallets so the poller watches them for elections/results/etc.
  for (const org of indexer.orgs.values()) {
    if (!watched.has(org.addr)) watched.set(org.addr, null);
  }
}

// Full reconcile: drop the in-memory cache and re-ingest every watched address
// from the chain, then replay. Because the read model is a deterministic replay
// of the transaction log, the cache (in-memory txLog + the `chain_txs` table) is
// disposable — this proves it: after a resync the state is identical to a cold
// boot. `truncateDb` also clears the durable cache so it is rebuilt from chain.
async function resyncFromChain({ truncateDb = false } = {}) {
  if (truncateDb && pool) {
    try { await pool.query('TRUNCATE chain_txs'); } catch (e) { console.error('truncate chain_txs failed:', e.message); }
  }
  txLog.length = 0;
  seen.clear();
  // Reset cursors but keep the discovered watch set so org wallets are re-read.
  for (const addr of watched.keys()) watched.set(addr, null);
  await pollOnce();
  return { txs: txLog.length, orgs: indexer.orgs.size, elections: indexer.elections.size };
}

async function pollOnce() {
  let added = false;
  // Snapshot per-election signatures BEFORE replay so we can push only the
  // elections that actually changed once the new state is built.
  const before = electionSignatures();
  if (LOCAL_DEV || MOCK_TX_FLOW) {
    // Self-contained ingest: replay the in-process mock ledger (fed by
    // /__mock/submit). No chain read-back, so NODE_RPC_URL / EXPLORER_API_URL
    // are never consulted for the transaction path.
    for (const raw of mock.all()) if (ingestRaw(raw)) added = true;
  } else {
    for (const [addr, cursor] of watched) {
      let txs = [];
      try { txs = await source.listTransactions({ account: addr, sinceCursor: cursor }); } catch { continue; }
      if (!Array.isArray(txs)) continue;
      for (const raw of txs) {
        if (ingestRaw(raw)) added = true;
        const n = normalizeTx(raw);
        if (n.createdAt && (!cursor || n.createdAt > cursor)) watched.set(addr, n.createdAt);
      }
    }
  }
  rebuild(); // deterministic full replay — cheap at this scale
  // Push live updates for any election whose signature changed (new result,
  // vote-resolved dispute, structural change) or that is brand new.
  const after = electionSignatures();
  for (const [eid, sig] of after) {
    if (before.get(eid) !== sig) ssePublish(eid, { kind: 'chain', lastUpdated: electionLastUpdated(eid) });
  }
  return added;
}

// ── Demo seed (obviously fake; only in local-dev / staging) ──────────────────
// Election id for the 2024 Indonesian presidential presentation dataset.
const PILPRES_EID = 'demo-pilpres-2024';
function evHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function buildDemoTxs() {
  let t = Date.parse('2026-06-19T08:00:00.000Z');
  const at = () => new Date(t += 60000).toISOString();
  const mk = (txId, from, to, amount, env) => ({ txId, from, to, amount, memo: memo.encode(env), createdAt: at() });
  const eid = 'demo-election';
  const ev1 = evHash('Staging demo — tally sheet station 1');
  const ev2 = evHash('Staging demo — tally sheet station 3');

  const txs = [
    // Organizations — one pays the fee (active), one does not (pending).
    mk('demo_org_a', DEMO.orgA, TREASURY_ADDR, ORG_FEE, memo.orgMemo('Staging demo — Citizens Count', 'Demo Republic')),
    mk('demo_org_b', DEMO.orgB, TREASURY_ADDR, 0, memo.orgMemo('Staging demo — Unpaid Org', 'Demo Republic')),
    // Active org with NO elections — proves "Organisasi aktif" lists active orgs
    // directly, not derived from elections.
    mk('demo_pollwatch', DEMO.pollwatch, TREASURY_ADDR, ORG_FEE, memo.orgMemo('Staging demo — Pollwatch Alliance', 'Demo Republic')),
    // Election + candidates (by the active org).
    mk(eid, DEMO.orgA, DEMO.orgA, 0, memo.electionMemo('Staging demo — General Election')),
    mk('demo_c1', DEMO.orgA, DEMO.orgA, 0, memo.candidateMemo(eid, 1, 'Demo Candidate Red')),
    mk('demo_c2', DEMO.orgA, DEMO.orgA, 0, memo.candidateMemo(eid, 2, 'Demo Candidate Blue')),
    mk('demo_c3', DEMO.orgA, DEMO.orgA, 0, memo.candidateMemo(eid, 3, 'Demo Candidate Green')),
    // Stations.
    mk('demo_s1', DEMO.orgA, DEMO.orgA, 0, memo.stationMemo(eid, 1, 'Demo Station A', 'North district')),
    mk('demo_s2', DEMO.orgA, DEMO.orgA, 0, memo.stationMemo(eid, 2, 'Demo Station B', 'East district')),
    mk('demo_s3', DEMO.orgA, DEMO.orgA, 0, memo.stationMemo(eid, 3, 'Demo Station C', 'South district')),
    mk('demo_s4', DEMO.orgA, DEMO.orgA, 0, memo.stationMemo(eid, 4, 'Demo Station D', 'West district')),
    // Observers (one scoped to station 2).
    mk('demo_o1', DEMO.orgA, DEMO.orgA, 0, memo.observerMemo(eid, DEMO.obs1)),
    mk('demo_o2', DEMO.orgA, DEMO.orgA, 0, memo.observerMemo(eid, DEMO.obs2)),
    mk('demo_o3', DEMO.orgA, DEMO.orgA, 0, memo.observerMemo(eid, DEMO.obs3, 2)),
    // Station 1: two submissions (latest wins) — later one carries evidence.
    mk('demo_res_s1_a', DEMO.obs1, DEMO.orgA, 0, memo.resultMemo(eid, 1, { 1: 40, 2: 60, 3: 12 }, 117, 5)),
    mk('demo_res_s1_b', DEMO.obs2, DEMO.orgA, 0, memo.resultMemo(eid, 1, { 1: 52, 2: 71, 3: 14 }, 142, 5, ev1)),
    // Station 2: two observers disagree → exercises consensus / median / review.
    mk('demo_res_s2_a', DEMO.obs3, DEMO.orgA, 0, memo.resultMemo(eid, 2, { 1: 80, 2: 35, 3: 20 }, 140, 5)),
    mk('demo_res_s2_b', DEMO.obs1, DEMO.orgA, 0, memo.resultMemo(eid, 2, { 1: 81, 2: 33, 3: 21 }, 140, 5)),
    // Station 3: one submission with evidence — later invalidated by an upheld dispute.
    mk('demo_res_s3_a', DEMO.obs1, DEMO.orgA, 0, memo.resultMemo(eid, 3, { 1: 200, 2: 5, 3: 5 }, 215, 5, ev2)),
    // Station 4: no submission → "3 of 4 reported".
    // Disputes: one open (station 2), one upheld (station 3 → invalid).
    mk('demo_disp_open', DEMO.obs2, DEMO.orgA, 0, memo.disputeMemo(eid, 'demo_res_s2_a', 'Numbers look inconsistent with turnout')),
    mk('demo_disp_up', DEMO.obs2, DEMO.orgA, 0, memo.disputeMemo(eid, 'demo_res_s3_a', 'Tally sheet altered', ev2)),
    mk('demo_dres_up', DEMO.orgA, DEMO.orgA, 0, memo.resolveMemo(eid, 'demo_disp_up', 'uphold')),

    // ── Organization management (members, roles, visibility, deletion) ──────
    // Citizens Count (orgA, active/public) gets a full roster, all addressed to
    // the org wallet so the poller discovers them.
    mk('demo_mem_admin', DEMO.orgA, DEMO.orgA, 0, memo.memberMemo(DEMO.orgA, DEMO.orgAdmin, 'admin')),
    mk('demo_mem_mod', DEMO.orgA, DEMO.orgA, 0, memo.memberMemo(DEMO.orgA, DEMO.orgMod, 'mod')),
    mk('demo_mem_member', DEMO.orgA, DEMO.orgA, 0, memo.memberMemo(DEMO.orgA, DEMO.orgMember, 'member')),
    // Promote/demote demo: obs1 is added as a member, promoted to moderator,
    // then demoted back to member — three verifiable on-chain events.
    mk('demo_mem_obs1_a', DEMO.orgA, DEMO.orgA, 0, memo.memberMemo(DEMO.orgA, DEMO.obs1, 'member')),
    mk('demo_mem_obs1_b', DEMO.orgAdmin, DEMO.orgA, 0, memo.memberMemo(DEMO.orgA, DEMO.obs1, 'mod')),
    mk('demo_mem_obs1_c', DEMO.orgA, DEMO.orgA, 0, memo.memberMemo(DEMO.orgA, DEMO.obs1, 'member')),

    // A second, PRIVATE org with a private election visible only to its members.
    mk('demo_org_c', DEMO.orgC, TREASURY_ADDR, ORG_FEE, memo.orgMemo('Staging demo — Private Watchers', 'Demo Republic')),
    mk('demo_org_c_vis', DEMO.orgC, DEMO.orgC, 0, memo.visibilityMemo(DEMO.orgC, 'private')),
    mk('demo_org_c_mem', DEMO.orgC, DEMO.orgC, 0, memo.memberMemo(DEMO.orgC, DEMO.orgMember, 'member')),
    mk('demo_elc', DEMO.orgC, DEMO.orgC, 0, memo.electionMemo('Staging demo — Private Election')),
    mk('demo_elc_c1', DEMO.orgC, DEMO.orgC, 0, memo.candidateMemo('demo_elc', 1, 'Private Candidate A')),
    mk('demo_elc_c2', DEMO.orgC, DEMO.orgC, 0, memo.candidateMemo('demo_elc', 2, 'Private Candidate B')),
    mk('demo_elc_s1', DEMO.orgC, DEMO.orgC, 0, memo.stationMemo('demo_elc', 1, 'Private Station 1', 'Central')),

    // A deleted (tombstoned) org — registered, then deleted by its owner.
    mk('demo_org_d', DEMO.orgD, TREASURY_ADDR, ORG_FEE, memo.orgMemo('Staging demo — Retired Org', 'Demo Republic')),
    mk('demo_org_d_mem', DEMO.orgD, DEMO.orgD, 0, memo.memberMemo(DEMO.orgD, DEMO.orgMember, 'member')),
    mk('demo_org_d_del', DEMO.orgD, DEMO.orgD, 0, memo.deleteOrgMemo(DEMO.orgD)),

    // ── Presentation dataset: 2024 Indonesian presidential election ─────────
    // A recognizable, realistic sample election that sits ALONGSIDE the generic
    // demo-election above (which is left untouched). Tallies are fictional
    // samples TUNED so the aggregated national shares track the published 2024
    // result — ~24.95% Anies–Muhaimin, ~58.59% Prabowo–Gibran, ~16.47%
    // Ganjar–Mahfud — for display only; these are NOT certified results. The
    // "Staging demo —" prefix keeps it obviously fake; the organizing org is a
    // fictional watchdog, NOT Indonesia's real election commission.
    mk('demo_pilpres_org', DEMO.orgID, TREASURY_ADDR, ORG_FEE, memo.orgMemo('Staging demo — Pemilu Watch (Indonesia)', 'Indonesia')),
    mk(PILPRES_EID, DEMO.orgID, DEMO.orgID, 0, memo.electionMemo('Staging demo — Pilpres 2024 (Indonesia)')),
    // Candidate pairs, by official ballot number (president & vice-president).
    mk('demo_pilpres_c1', DEMO.orgID, DEMO.orgID, 0, memo.candidateMemo(PILPRES_EID, 1, 'Anies Baswedan & Muhaimin Iskandar')),
    mk('demo_pilpres_c2', DEMO.orgID, DEMO.orgID, 0, memo.candidateMemo(PILPRES_EID, 2, 'Prabowo Subianto & Gibran Rakabuming')),
    mk('demo_pilpres_c3', DEMO.orgID, DEMO.orgID, 0, memo.candidateMemo(PILPRES_EID, 3, 'Ganjar Pranowo & Mahfud MD')),
    // Polling stations, each tagged with its province (feeds the Turnout heatmap).
    mk('demo_pilpres_s1', DEMO.orgID, DEMO.orgID, 0, memo.stationMemo(PILPRES_EID, 1, 'TPS DKI Jakarta — Sample', 'DKI Jakarta')),
    mk('demo_pilpres_s2', DEMO.orgID, DEMO.orgID, 0, memo.stationMemo(PILPRES_EID, 2, 'TPS Jawa Barat — Sample', 'Jawa Barat')),
    mk('demo_pilpres_s3', DEMO.orgID, DEMO.orgID, 0, memo.stationMemo(PILPRES_EID, 3, 'TPS Jawa Tengah — Sample', 'Jawa Tengah')),
    mk('demo_pilpres_s4', DEMO.orgID, DEMO.orgID, 0, memo.stationMemo(PILPRES_EID, 4, 'TPS Jawa Timur — Sample', 'Jawa Timur')),
    mk('demo_pilpres_s5', DEMO.orgID, DEMO.orgID, 0, memo.stationMemo(PILPRES_EID, 5, 'TPS Sumatera Utara — Sample', 'Sumatera Utara')),
    // Observers (reuse the existing demo observer wallets — an observer may be
    // authorized on multiple elections).
    mk('demo_pilpres_o1', DEMO.orgID, DEMO.orgID, 0, memo.observerMemo(PILPRES_EID, DEMO.obs1)),
    mk('demo_pilpres_o2', DEMO.orgID, DEMO.orgID, 0, memo.observerMemo(PILPRES_EID, DEMO.obs2)),
    mk('demo_pilpres_o3', DEMO.orgID, DEMO.orgID, 0, memo.observerMemo(PILPRES_EID, DEMO.obs3)),
    // Reported-station tallies are tuned so the 'latest'-per-station national
    // aggregate lands on the real 2024 shares: Anies 522 / Prabowo 1226 /
    // Ganjar 345 (n=2093) → 24.94% / 58.58% / 16.48%.
    // Station 1 (Jakarta): Anies strongest.
    mk('demo_pilpres_r1', DEMO.obs1, DEMO.orgID, 0, memo.resultMemo(PILPRES_EID, 1, { 1: 195, 2: 165, 3: 55 }, 430, 9)),
    // Station 2 (West Java): Prabowo dominant.
    mk('demo_pilpres_r2', DEMO.obs2, DEMO.orgID, 0, memo.resultMemo(PILPRES_EID, 2, { 1: 125, 2: 365, 3: 50 }, 560, 12)),
    // Station 3 (Central Java): Prabowo leads, Ganjar elevated — two observers
    // disagree slightly, exercising the consensus / median view. The later
    // submission (r3b) is the 'latest' row that feeds the headline aggregate.
    mk('demo_pilpres_r3a', DEMO.obs1, DEMO.orgID, 0, memo.resultMemo(PILPRES_EID, 3, { 1: 90, 2: 298, 3: 151 }, 558, 10)),
    mk('demo_pilpres_r3b', DEMO.obs3, DEMO.orgID, 0, memo.resultMemo(PILPRES_EID, 3, { 1: 92, 2: 296, 3: 150 }, 558, 10)),
    // Station 4 (East Java): Prabowo dominant.
    mk('demo_pilpres_r4', DEMO.obs2, DEMO.orgID, 0, memo.resultMemo(PILPRES_EID, 4, { 1: 110, 2: 400, 3: 90 }, 622, 14)),
    // Station 5 (North Sumatra): no submission → "4 of 5 stations reported".

    // ── Closed election — demonstrates the closed badge and locked workspace ──
    mk('demo-closed-election', DEMO.orgA, DEMO.orgA, 0, memo.electionMemo('Staging demo — Closed Election')),
    mk('demo_closed_c1', DEMO.orgA, DEMO.orgA, 0, memo.candidateMemo('demo-closed-election', 1, 'Demo Candidate Alpha')),
    mk('demo_closed_c2', DEMO.orgA, DEMO.orgA, 0, memo.candidateMemo('demo-closed-election', 2, 'Demo Candidate Beta')),
    mk('demo_closed_s1', DEMO.orgA, DEMO.orgA, 0, memo.stationMemo('demo-closed-election', 1, 'Demo Station X', 'Central')),
    mk('demo_closed_o1', DEMO.orgA, DEMO.orgA, 0, memo.observerMemo('demo-closed-election', DEMO.obs1)),
    mk('demo_closed_r1', DEMO.obs1, DEMO.orgA, 0, memo.resultMemo('demo-closed-election', 1, { 1: 85, 2: 42 }, 132, 5)),
    mk('demo_closed_ecl', DEMO.orgA, DEMO.orgA, 0, memo.electionCloseMemo('demo-closed-election')),
  ];
  return txs;
}

function seedDemo() {
  if (!IS_DEMO) return;
  const txs = buildDemoTxs();
  if (LOCAL_DEV) {
    for (const tx of txs) mock.append(tx); // flows through the normal poll path
  } else {
    for (const tx of txs) ingestRaw(tx);
  }
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Stable fallback sender for mock submissions that omit `from`. The hosted
// bridge's mock mode derives the sender from its own configured identity and
// may POST only { to, amount, memo }; the app's own QCMock always sends `from`.
const MOCK_FALLBACK_ADDR = 'ut1mockwallet000000000000000000000000000000';

// Populate req.user from the iframe token BEFORE the mock routes below (which are
// registered ahead of the gating middleware and would otherwise never see it).
// This only IDENTIFIES the caller — it never gates — so /__mock/submit can derive
// the real wallet from req.user and resist a spoofed `from`. The gating middleware
// further down still enforces auth for everything else.
app.use((req, _res, next) => {
  if (!req.user) {
    const token = req.query.token || req.headers['x-usernode-token'];
    if (token && JWT_SECRET) { try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* ignore */ } }
  }
  next();
});

// Mock / local-ingest chain endpoints — mounted BEFORE the auth gate so the
// /__mock/ prefix (in PUBLIC_PREFIXES) is reachable from the iframe. With
// MOCK_TX_FLOW on (the default everywhere) this is the canonical, self-contained
// transaction surface: the hosted bridge enters mock mode (the GET /__mock/enabled
// probe returns 200) and the app routes every submission here, where it is
// ingested directly into the event log. No chain broadcast / read-back occurs.
if (MOCK_TX_FLOW || LOCAL_DEV) {
  // Probed by the hosted bridge to decide whether to enter mock mode. A 200
  // here makes the bridge route transactions through /__mock/* instead of
  // failing with "Mock API not enabled".
  app.get('/__mock/enabled', (_req, res) => res.json({ enabled: true }));
  app.post('/__mock/submit', async (req, res) => {
    const { from, to, amount, memo: m } = req.body || {};
    // Reject undecodable memos up front so a bad payload can never poison the
    // event log (rebuild() replays every row in txLog).
    if (memo.decode(m) == null) return res.status(400).json({ error: 'invalid memo' });
    // Sender precedence: the authenticated wallet (req.user, populated from the
    // JWT before the public-prefix gate) wins so org ownership is the real user
    // and a client cannot spoof `from`. Falls back to the client-supplied sender
    // (local-dev personas / QCMock) and finally a stable mock address.
    const sender = (req.user && req.user.usernode_pubkey) || from || MOCK_FALLBACK_ADDR;
    const tx = mock.append({ from: sender, to: to || sender, amount: amount || 0, memo: m });
    await pollOnce();
    res.json({ txId: tx.txId, ok: true });
  });
  app.get('/__mock/transactions', (_req, res) => res.json({ transactions: mock.all() }));
  // Destructive / test-only surface stays gated to developer + demo environments
  // so it can never be hit by a real user in production.
  if (LOCAL_DEV || IS_DEMO) {
    app.post('/__mock/reset', async (_req, res) => { mock.reset(); txLog.length = 0; seen.clear(); rebuild(); res.json({ ok: true }); });
    app.post('/__mock/seed', async (_req, res) => { seedDemo(); await pollOnce(); res.json({ ok: true, txs: mock.size() }); });
  } else {
    app.all(['/__mock/reset', '/__mock/seed'], (_req, res) => res.status(404).json({ error: 'mock admin disabled' }));
  }
} else {
  // MOCK_TX_FLOW explicitly disabled (real-chain reads): the mock surface must
  // be genuinely absent so the SPA catch-all (app.get('*')) can't answer the
  // bridge's GET /__mock/enabled probe with a 200 index.html — which would
  // wrongly switch the bridge into mock mode.
  app.all('/__mock/*', (_req, res) => res.status(404).json({ error: 'mock disabled' }));
}

// ── Pay-to-unlock config ─────────────────────────────────────────────────────
const UNLOCK_RECIPIENT = process.env.UNLOCK_RECIPIENT_ADDRESS || '';
const UNLOCK_PRICE = Math.max(0, parseInt(process.env.UNLOCK_PRICE_TOKENS || '0', 10) || 0);
const UNLOCK_ENABLED = !!UNLOCK_RECIPIENT;

// Paths that stay open without authentication.
const JWT_SECRET = process.env.JWT_SECRET;
// /api/me + /api/me/profile are listed public so they don't 401 without a
// token: identity is resolved inside the handlers. In production the wallet
// comes only from req.user (the auth middleware still populates it from any
// token); the `viewer` fallback is honored ONLY in local-dev / staging so a
// production caller can never read or write another wallet's profile.
const PUBLIC_API_PATHS = new Set(['/health', '/api/me', '/api/me/profile']);
const PUBLIC_PREFIXES = ['/__quickcount/', '/__mock/', '/explorer-api/', '/api/public/'];
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) { try { req.user = jwt.verify(token, JWT_SECRET); } catch { /* ignore */ } }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// Public config for the frontend (SPA).
app.get('/__quickcount/config', (_req, res) => {
  // Each persona carries a simulated Usernode Username so the identity-by-username
  // flow runs identically offline (the mock bridge surfaces it as the active user).
  const personas = LOCAL_DEV ? [
    { label: 'Org Owner — Citizens Count', addr: DEMO.orgA, username: 'citizens_count' },
    { label: 'Org Administrator', addr: DEMO.orgAdmin, username: null },
    { label: 'Org Moderator', addr: DEMO.orgMod, username: null },
    { label: 'Org Member', addr: DEMO.orgMember, username: null },
    { label: 'Org Owner — Private Watchers', addr: DEMO.orgC, username: null },
    { label: 'Org Owner — Pemilu Watch (Indonesia)', addr: DEMO.orgID, username: 'pemilu_watch_id' },
    { label: 'Observer One', addr: DEMO.obs1, username: 'observer_one' },
    { label: 'Observer Three (Station B)', addr: DEMO.obs3, username: 'observer_three' },
    { label: 'Platform Admin', addr: DEMO.admin, username: 'platform_admin' },
    { label: 'Fresh wallet', addr: null, username: null },
  ] : null;
  res.json({
    localDev: LOCAL_DEV, staging: IS_STAGING, demo: IS_DEMO,
    // Self-contained local-ingest mode: the client confirms optimistically and
    // suppresses the "on-chain sync not configured" banner / awaiting-sync notice.
    mockMode: MOCK_TX_FLOW,
    treasury: TREASURY_ADDR, orgFee: ORG_FEE, adminAddrs: ADMIN_ADDRS,
    methods: require('./lib/aggregate').METHODS, personas,
    // Chain read config for the client confirmation poll. The browser builds
    // <explorerApiBase>/<chainId>/transactions; both are auth-exempt.
    // chainConfigured=false (no explorer/node upstream) tells the client to
    // confirm optimistically rather than dead-end on a 20s timeout. In mock mode
    // there is nothing to poll, so report configured (the banner is mockMode-driven).
    chainId: CHAIN_ID, explorerApiBase: EXPLORER_API_BASE, chainConfigured: MOCK_TX_FLOW ? true : source.configured,
    // App's own on-chain identity (public address only — the secret is never
    // surfaced). null when unset so the client can tell it apart from a value.
    appPubkey: APP_PUBKEY || null,
    // Cadence the SPA auto-refresh should use (ms); already floored at 1000.
    timerDurationMs: TIMER_DURATION_MS,
  });
});

// Trigger an immediate chain ingest so a just-confirmed transaction reflects in
// the read model without waiting for the next background poll. GET + under the
// auth-exempt /__quickcount/ prefix so the client can call it right after a
// confirmation; the work is a cheap read-only replay, already running on a timer.
app.get('/__quickcount/refresh', async (_req, res) => {
  try { await pollOnce(); res.json({ ok: true, txs: txLog.length }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// Browser-facing chain read proxy. The client confirmation poll (index.html
// confirmTx) and the public dashboard's unlock confirm POST to
// /explorer-api/<chain>/transactions to wait for a just-sent transaction to
// appear on the ledger. The browser can't reach EXPLORER_API_URL / NODE_RPC_URL
// directly (internal hostnames / CORS), so the app forwards the query to the
// SAME upstream the server-side indexer reads — via the shared postTransactions
// helper in lib/txsource.js. Read-only, side-effect-free, and auth-exempt (the
// /explorer-api/ prefix is in PUBLIC_PREFIXES). Registered before app.get('*')
// so the POST isn't swallowed by the SPA catch-all. Mirrors the path the hosted
// bridge itself polls. In local-dev the in-process mock answers instead and the
// client short-circuits confirmation, so this is effectively a production path.
app.post('/explorer-api/:chain/transactions', async (req, res) => {
  const url = resolveTxEndpoint({ explorerUrl: EXPLORER_API_URL, nodeUrl: NODE_RPC_URL, chainId: req.params.chain });
  if (!url) return res.status(503).json({ error: 'chain read source not configured', transactions: [] });
  const { status, data } = await postTransactions(url, req.body || {});
  const code = (status >= 200 && status < 600) ? status : 502;
  res.status(code).json(data == null ? { transactions: [] } : data);
});

// Has this wallet paid to unlock? Unlock is global per wallet and permanent.
async function walletUnlocked(pubkey) {
  if (!pubkey || !pool) return false;
  const { rows } = await pool.query('SELECT 1 FROM unlocks WHERE usernode_pubkey = $1', [pubkey]);
  return rows.length > 0;
}

// Public config (staging banner, unlock pricing). Public so the
// dashboard can read it before the viewer authenticates.
app.get('/api/public/config', (_req, res) => {
  res.json({
    staging: IS_STAGING,
    mockMode: MOCK_TX_FLOW,
    unlock: {
      enabled: UNLOCK_ENABLED,
      recipient: UNLOCK_RECIPIENT || null,
      price: UNLOCK_PRICE,
    },
    // Chain read config so the public dashboard can confirm the unlock payment
    // against the same explorer proxy the main app uses. chainConfigured=false
    // makes the dashboard confirm optimistically instead of timing out. In mock
    // mode there is nothing to poll, so report configured.
    chainId: CHAIN_ID, explorerApiBase: EXPLORER_API_BASE, chainConfigured: MOCK_TX_FLOW ? true : source.configured,
  });
});

// Visibility-aware app state. `viewer` is the connected wallet (or empty).
app.get('/__quickcount/state', async (req, res) => {
  try {
    const viewer = (req.query.viewer || '').toString() || null;
    const method = require('./lib/aggregate').METHODS.includes(req.query.method) ? req.query.method : 'latest';
    const role = indexer.viewerRole(viewer);
    const visible = indexer.visibleElections({ viewer, admin: role.isAdmin });
    const elections = visible.map((el) => indexer.electionSummary(el));

    let detail = null;
    if (req.query.eid) {
      const can = visible.some((el) => el.eid === req.query.eid);
      detail = can ? indexer.electionDetail(req.query.eid, method) : null;
      // Fold in the off-chain working tally so the workspace can hydrate the
      // inline vote-entry rows + upper bars on load.
      if (detail) detail.workTally = await loadWorkTally(req.query.eid);
      // Fold in per-station ballot-proof status (present/validated) so the
      // workspace can badge stations that already have a proof attached.
      if (detail) {
        const pm = await loadBallotProofMeta(req.query.eid);
        detail.proofs = {};
        for (const [sid, v] of pm) detail.proofs[sid] = v;
      }
    }
    res.json({ role, elections, detail, method, activeOrgs: indexer.activeOrgs() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Organizations the viewer owns or belongs to, each with its roster + the
// viewer's role. Read-only chain replay; auth-exempt under /__quickcount/.
app.get('/__quickcount/orgs', (req, res) => {
  try {
    const viewer = (req.query.viewer || '').toString() || null;
    const admin = indexer.isAdmin(viewer);
    res.json(indexer.orgsForViewer(viewer, { admin }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Platform-admin read view — all orgs incl. pending. Scoped to admin wallets.
app.get('/__quickcount/admin', (req, res) => {
  const viewer = (req.query.viewer || '').toString() || null;
  if (!indexer.isAdmin(viewer)) return res.status(403).json({ error: 'admin scope required' });
  const orgs = indexer.allOrgs();
  res.json({
    orgs,
    stats: {
      orgs: orgs.length,
      activeOrgs: orgs.filter((o) => o.active).length,
      elections: indexer.elections.size,
      treasury: TREASURY_ADDR,
      orgFee: ORG_FEE,
    },
  });
});

// ── Off-chain working tallies (per-station inline vote entry) ────────────────
// The election workspace lets an organizer key a quick "working tally" straight
// onto each polling-station row. This is NON-CONSENSUS off-chain data — not
// signed, not on-chain, never rebuilt by the indexer — kept separate from the
// official observer/QC.res reporting flow. It is persisted here (Postgres) so it
// survives reload and is reflected on the dashboard. Keyed by (eid, sid),
// latest-write-wins, like attachments.
//
// The inline form uses a fixed candidate set (mirrors QuickCountInline.CANDIDATES
// in public/inline-entry.js). We sanitize to these slugs so a bad body can never
// poison the stored votes.
const WORK_TALLY_SLUGS = ['evan', 'salah', 'circle'];
function sanitizeWorkVotes(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const slug of WORK_TALLY_SLUGS) {
    const n = Number(src[slug]);
    out[slug] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  return out;
}
// Read every saved station tally for an election. Returns [] without a pool so
// the feature degrades cleanly in pure-memory mode (the platform always sets
// DATABASE_URL, so this is the dev-only path).
async function loadWorkTally(eid) {
  if (!pool) return [];
  try {
    const { rows } = await pool.query(
      'SELECT sid, votes, updated_at FROM work_tallies WHERE eid = $1 ORDER BY sid',
      [eid]
    );
    return rows.map((r) => ({
      sid: Number(r.sid),
      votes: r.votes || {},
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : (r.updated_at || null),
    }));
  } catch (e) {
    console.error('loadWorkTally failed:', e.message);
    return [];
  }
}

// Authenticated: save (or replace) a station's working tally. Org-ownership
// guard mirrors the attachments PUT: only the election's organizing wallet —
// Owner, Administrator, or Moderator (canOperate) — or a platform admin may
// write. When the election isn't indexed yet, allow (nothing to overwrite).
app.put('/api/elections/:eid/worktally/:sid', async (req, res) => {
  try {
    const { eid } = req.params;
    const sid = Number(req.params.sid);
    if (!Number.isInteger(sid) || sid <= 0) return res.status(400).json({ error: 'bad station id' });

    // Authorization first (so "not allowed" wins over "unavailable"): only the
    // election's organizing wallet — Owner, Administrator, or Moderator — or a
    // platform admin may write. When the election isn't indexed yet (organizer
    // saving before the chain tx lands) we can't resolve the owner — allow it,
    // since there is nothing to overwrite.
    const authorPubkey = (req.user && req.user.usernode_pubkey) || null;
    const authorUsername = (req.user && req.user.username) || null;
    const el = indexer.elections.get(eid);
    if (el && !indexer.canOperate(el.orgAddr, authorPubkey) && !indexer.isAdmin(authorPubkey)) {
      return res.status(403).json({ error: 'Only the organizing wallet can save this election\'s working tally' });
    }

    // Off-chain working tallies live in the DB; without one the feature is
    // unavailable in this environment (degrade like attachments/profiles).
    if (!pool) return res.status(503).json({ error: 'Working tallies are unavailable in this environment' });

    const votes = sanitizeWorkVotes((req.body && req.body.votes) || req.body);
    const { rows } = await pool.query(
      `INSERT INTO work_tallies (eid, sid, votes, author_pubkey, author_username, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, NOW())
       ON CONFLICT (eid, sid)
       DO UPDATE SET votes = EXCLUDED.votes, author_pubkey = EXCLUDED.author_pubkey,
                     author_username = EXCLUDED.author_username, updated_at = NOW()
       RETURNING sid, votes, updated_at`,
      [eid, sid, JSON.stringify(votes), authorPubkey, authorUsername]
    );
    const r = rows[0] || {};
    // Live publish: the dashboard / open election screens update instantly.
    ssePublish(eid, { kind: 'worktally', sid, lastUpdated: electionLastUpdated(eid) });
    res.json({
      ok: true, eid, sid,
      votes: r.votes || votes,
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : (r.updated_at || null),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: every saved working tally for an election (for the standalone
// dashboard). Public — aggregate vote counts only, no PII.
app.get('/api/public/elections/:eid/worktally', async (req, res) => {
  try {
    res.json({ workTally: await loadWorkTally(req.params.eid) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Off-chain image attachments ──────────────────────────────────────────────
// Candidate avatars and station C1-form scans. NON-CONSENSUS off-chain data:
// not signed, not on-chain, never rebuilt by the indexer. Keyed by the same
// logical ids the chain uses so uploads don't depend on indexing lag.

// Authenticated: upload (or replace) an attachment. Route-scoped JSON parser
// with a raised limit — the global express.json() caps bodies at 100 KB.
const uploadJson = express.json({ limit: '4mb' });
app.put('/api/elections/:eid/attachments/:kind/:refId', uploadJson, async (req, res) => {
  try {
    const { eid, kind } = req.params;
    const refId = Number(req.params.refId);
    if (!isKind(kind)) return res.status(400).json({ error: 'unknown attachment kind' });
    if (!Number.isInteger(refId) || refId <= 0) return res.status(400).json({ error: 'bad ref id' });
    // Off-chain images live in the DB; without one the feature is unavailable in
    // this environment (degrade like profiles, never a 500).
    if (!pool) return res.status(503).json({ error: 'Attachments are unavailable in this environment' });

    const uploaderPubkey = (req.user && req.user.usernode_pubkey) || null;
    const uploaderUsername = (req.user && req.user.username) || null;
    // Org-ownership guard: only the election's organizing wallet (or an admin)
    // may write its images. When the election isn't indexed yet (an organizer
    // uploading at create time, before the on-chain `el` tx lands), we can't
    // resolve the owner — allow it, since there is nothing to overwrite.
    const el = indexer.elections.get(eid);
    if (el && !indexer.canOperate(el.orgAddr, uploaderPubkey) && !indexer.isAdmin(uploaderPubkey)) {
      return res.status(403).json({ error: 'Only the organizing wallet or its operators can upload this election\'s images' });
    }

    const { mime, data_base64 } = req.body || {};
    if (typeof data_base64 !== 'string' || !data_base64) {
      return res.status(400).json({ error: 'data_base64 required' });
    }
    let buf;
    try { buf = Buffer.from(data_base64, 'base64'); } catch { buf = null; }
    const check = validateImageUpload(mime, buf);
    if (!check.ok) return res.status(check.status || 400).json({ error: check.error });

    await pool.query(
      `INSERT INTO attachments (eid, kind, ref_id, mime, bytes, byte_size, uploader_pubkey, uploader_username, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (eid, kind, ref_id)
       DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
                     byte_size = EXCLUDED.byte_size, uploader_pubkey = EXCLUDED.uploader_pubkey,
                     uploader_username = EXCLUDED.uploader_username,
                     updated_at = NOW()`,
      [eid, kind, refId, mime, buf, buf.length, uploaderPubkey, uploaderUsername]
    );
    res.json({ ok: true, eid, kind, ref_id: refId, byte_size: buf.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: serve an attachment's bytes so the logged-out dashboard can load it.
app.get('/api/public/elections/:eid/attachments/:kind/:refId', async (req, res) => {
  try {
    const { eid, kind } = req.params;
    const refId = Number(req.params.refId);
    if (!isKind(kind) || !Number.isInteger(refId) || refId <= 0) {
      return res.status(404).json({ error: 'not found' });
    }
    const { rows } = await pool.query(
      'SELECT mime, bytes FROM attachments WHERE eid = $1 AND kind = $2 AND ref_id = $3',
      [eid, kind, refId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', rows[0].mime);
    res.set('Cache-Control', 'public, max-age=60');
    res.send(rows[0].bytes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ballot-proof upload flow (off-chain, PRIVATE) ────────────────────────────
// A scanned ballot / count form attached to a polling station. Stored in the
// PRIVATE `ballot_proofs` table (may carry PII) — bytes are served only to the
// uploader, the org's operators, or a platform operator. The anonymous public
// sees only a "validated proof present" badge (see the per-station `proof`
// field below), never the raw document; the on-chain `ev` hash remains the
// public, verifiable commitment.

// Per-station proof status for an election: sid -> { present, validated }.
// `present` means a submitted proof exists; `validated` means it passed
// document validation. Draft proofs (mid-review) are intentionally excluded.
async function loadBallotProofMeta(eid) {
  const m = new Map();
  if (!pool) return m;
  try {
    const { rows } = await pool.query(
      'SELECT sid, valid, status FROM ballot_proofs WHERE eid = $1',
      [eid]
    );
    for (const r of rows) {
      const submitted = r.status === 'submitted';
      m.set(Number(r.sid), { present: submitted, validated: submitted && !!r.valid });
    }
  } catch (e) {
    console.error('loadBallotProofMeta failed:', e.message);
  }
  return m;
}

// May `pubkey` upload/replace a station's ballot proof? The station's assigned
// observer (broader than the worktally guard — they hold the physical ballot),
// the org's operators (Owner/Administrator/Moderator), or a platform operator.
// When the election isn't indexed yet, allow (nothing to overwrite).
function canUploadProof(eid, sid, pubkey) {
  if (!pubkey) return false;
  const el = indexer.elections.get(eid);
  if (!el) return true;
  if (indexer.isAdmin(pubkey)) return true;
  if (indexer.canOperate(el.orgAddr, pubkey)) return true;
  const obsMap = indexer.observers.get(eid);
  const obs = obsMap && obsMap.get(pubkey);
  if (obs && (obs.sid == null || obs.sid === sid)) return true;
  return false;
}

// Authenticated: import (draft) or submit (final) a station ballot proof. The
// server always re-runs validation and refuses to mark a proof `submitted`
// unless it passes — never trusts the client's pass/fail.
const ballotJson = express.json({ limit: '8mb' });
app.put('/api/elections/:eid/ballot-proof/:sid', ballotJson, async (req, res) => {
  try {
    const { eid } = req.params;
    const sid = Number(req.params.sid);
    if (!Number.isInteger(sid) || sid <= 0) return res.status(400).json({ error: 'bad station id' });
    const pubkey = (req.user && req.user.usernode_pubkey) || null;
    const username = (req.user && req.user.username) || null;
    if (!canUploadProof(eid, sid, pubkey)) {
      return res.status(403).json({ error: 'You are not authorized to upload a ballot proof for this station' });
    }
    if (!pool) return res.status(503).json({ error: 'Ballot proofs are unavailable in this environment' });

    const { mime, data_base64, status } = req.body || {};
    if (typeof data_base64 !== 'string' || !data_base64) {
      return res.status(400).json({ error: 'data_base64 required' });
    }
    let buf;
    try { buf = Buffer.from(data_base64, 'base64'); } catch { buf = null; }
    const check = validateBallotProof(mime, buf);
    const wantSubmit = status === 'submitted';
    // A submit must pass validation; a draft is stored regardless so the
    // reviewer's in-progress (even failing) state survives a reload.
    if (wantSubmit && !check.ok) {
      return res.status(check.status || 400).json({ error: check.error, validation: check });
    }
    const finalStatus = wantSubmit ? 'submitted' : 'draft';
    const info = check.info || {};
    const size = Buffer.isBuffer(buf) ? buf.length : 0;
    await pool.query(
      `INSERT INTO ballot_proofs
         (eid, sid, mime, bytes, byte_size, page_count, width, height, valid, validation, status, uploader_pubkey, uploader_username, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13, NOW())
       ON CONFLICT (eid, sid) DO UPDATE SET
         mime = EXCLUDED.mime, bytes = EXCLUDED.bytes, byte_size = EXCLUDED.byte_size,
         page_count = EXCLUDED.page_count, width = EXCLUDED.width, height = EXCLUDED.height,
         valid = EXCLUDED.valid, validation = EXCLUDED.validation, status = EXCLUDED.status,
         uploader_pubkey = EXCLUDED.uploader_pubkey, uploader_username = EXCLUDED.uploader_username,
         updated_at = NOW()`,
      [
        eid, sid, mime || null, buf, size,
        info.pages == null ? null : info.pages,
        info.width == null ? null : info.width,
        info.height == null ? null : info.height,
        !!check.ok, JSON.stringify(check), finalStatus, pubkey, username,
      ]
    );
    // A finalized (submitted + valid) proof flips the public badge → push live.
    if (finalStatus === 'submitted') ssePublish(eid, { kind: 'proof', sid, lastUpdated: electionLastUpdated(eid) });
    res.json({ ok: true, eid, sid, status: finalStatus, valid: !!check.ok, validation: check, byte_size: size });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authenticated: read a station's ballot-proof bytes (or ?meta=1 for status
// only). NOT public — restricted to the uploader, org operators, or a platform
// operator. The anonymous public only ever gets the badge on the public detail.
app.get('/api/elections/:eid/ballot-proof/:sid', async (req, res) => {
  try {
    const { eid } = req.params;
    const sid = Number(req.params.sid);
    if (!Number.isInteger(sid) || sid <= 0) return res.status(404).json({ error: 'not found' });
    if (!pool) return res.status(503).json({ error: 'Ballot proofs are unavailable in this environment' });
    const pubkey = (req.user && req.user.usernode_pubkey) || null;
    const { rows } = await pool.query(
      'SELECT mime, bytes, byte_size, valid, status, uploader_pubkey, validation FROM ballot_proofs WHERE eid = $1 AND sid = $2',
      [eid, sid]
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const row = rows[0];
    const el = indexer.elections.get(eid);
    const allowed = !!pubkey && (
      indexer.isAdmin(pubkey)
      || (el && indexer.canOperate(el.orgAddr, pubkey))
      || pubkey === row.uploader_pubkey
    );
    if (!allowed) return res.status(403).json({ error: 'Not authorized to view this ballot proof' });
    if (req.query.meta) {
      return res.json({
        eid, sid, status: row.status, valid: !!row.valid,
        byte_size: row.byte_size, validation: row.validation || null,
      });
    }
    res.set('Content-Type', row.mime || 'application/octet-stream');
    res.set('Cache-Control', 'private, max-age=30');
    res.send(row.bytes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: live event stream for one election (SSE). Under /api/public/ so it is
// ungated. Carries only { eid, kind, lastUpdated } — clients re-fetch through
// the pay-to-unlock-aware detail endpoint, so the lock gate is unchanged.
app.get('/api/public/elections/:eid/stream', (req, res) => {
  const eid = req.params.eid;
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  if (sseCount >= SSE_MAX) {
    res.write('event: error\ndata: {"error":"too many live connections"}\n\n');
    return res.end();
  }
  res.write('retry: 3000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ eid, lastUpdated: electionLastUpdated(eid) })}\n\n`);
  const unsubscribe = sseSubscribe(eid, res);
  const heartbeat = setInterval(() => { try { res.write(': heartbeat\n\n'); } catch { /* closed */ } }, 25000);
  req.on('close', () => { clearInterval(heartbeat); unsubscribe(); });
});

// Public: list elections with counts (backed by in-memory indexer).
app.get('/api/public/elections', (_req, res) => {
  try {
    const visible = indexer.visibleElections({ viewer: null, admin: false });
    res.json({
      elections: visible.map((el) => {
        const s = indexer.electionSummary(el);
        return {
          eid: s.eid,
          name: s.name,
          candidate_count: s.candidateCount,
          station_count: s.stationCount,
          reported_count: s.reportedCount,
        };
      }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: election detail with pay-to-unlock gate (backed by in-memory indexer).
app.get('/api/public/elections/:eid', async (req, res) => {
  try {
    const eid = req.params.eid;
    const visible = indexer.visibleElections({ viewer: null, admin: false });
    if (!visible.some((el) => el.eid === eid)) return res.status(404).json({ error: 'not found' });
    const d = indexer.electionDetail(eid, 'latest');
    if (!d) return res.status(404).json({ error: 'not found' });

    // Resolve avatar and C1 attachment URLs from the off-chain attachments table.
    let hasAvatar = new Set(), hasC1 = new Set();
    if (pool) {
      const att = (await pool.query('SELECT kind, ref_id FROM attachments WHERE eid = $1', [eid])).rows;
      hasAvatar = new Set(att.filter((a) => a.kind === 'cand_avatar').map((a) => Number(a.ref_id)));
      hasC1 = new Set(att.filter((a) => a.kind === 'station_c1').map((a) => Number(a.ref_id)));
    }
    const avatarUrl = (cid) => `/api/public/elections/${encodeURIComponent(eid)}/attachments/cand_avatar/${cid}`;
    const c1Url = (sid) => `/api/public/elections/${encodeURIComponent(eid)}/attachments/station_c1/${sid}`;

    // Per-station ballot-proof badge (public sees presence/validated only — never
    // the bytes, which require authorization on the separate /api endpoint).
    const proofMeta = await loadBallotProofMeta(eid);
    const proofOf = (sid) => proofMeta.get(Number(sid)) || { present: false, validated: false };

    const candidates = d.candidates.map((c) => ({
      cid: c.cid, name: c.name,
      avatar: hasAvatar.has(Number(c.cid)) ? avatarUrl(Number(c.cid)) : null,
    }));

    // Pay-to-unlock gate. The auth middleware has already populated req.user
    // from any token, even on this public path, so one endpoint serves both
    // locked (anonymous / unpaid) and unlocked (paid wallet) viewers.
    const unlocked = await walletUnlocked(req.user && req.user.usernode_pubkey);

    // Off-chain working tally — separate from the pay-to-unlock official
    // results, so it is served to locked and unlocked viewers alike.
    const workTally = await loadWorkTally(eid);

    const base = {
      election: { eid: d.election.eid, name: d.election.name, root_pubkey: d.election.orgAddr },
      candidates,
      reporting: d.reporting,
      lastUpdated: d.lastUpdated,
      locked: !unlocked,
      workTally,
    };

    if (unlocked) {
      const stations = d.stations.map((s) => ({
        sid: s.sid, name: s.name, reported: s.reported,
        votes: s.votes, tot: s.tot, inv: s.inv, at: s.at,
        c1: hasC1.has(s.sid) ? c1Url(s.sid) : null,
        proof: proofOf(s.sid),
      }));
      return res.json(Object.assign(base, { stations, tally: d.tally }));
    }

    // Locked: withhold vote figures so the blur cannot be defeated in dev-tools.
    // Keep structure (names, reported flag, reporting counts) for the placeholder UI.
    const lockedStations = d.stations.map((s) => ({
      sid: s.sid, name: s.name, reported: s.reported,
      votes: null, tot: null, inv: null, at: null,
      proof: proofOf(s.sid),
    }));
    return res.json(Object.assign(base, { stations: lockedStations, tally: null }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Authenticated: verify an on-chain unlock payment and record a permanent
// per-wallet unlock. NOT in PUBLIC_API_PATHS — stays behind the JWT gate.
app.post('/api/unlock/verify', async (req, res) => {
  try {
    const pubkey = req.user && req.user.usernode_pubkey;
    const username = (req.user && req.user.username) || null;
    if (!pubkey) return res.status(400).json({ error: 'Link a Usernode wallet first' });
    if (!UNLOCK_ENABLED) return res.status(503).json({ error: 'Unlocking is not configured' });
    // Off-chain unlock records live in the DB; without one the feature is simply
    // unavailable in this environment (degrade like profiles, never a 500).
    if (!pool) return res.status(503).json({ error: 'Unlocking is unavailable in this environment' });

    // Already paid → idempotent success (never charge twice).
    if (await walletUnlocked(pubkey)) return res.json({ unlocked: true });

    if (IS_STAGING) {
      // No live chain in staging — record a clearly-labelled demo unlock so the
      // unlocked view is reviewable without a real payment.
      await pool.query(
        `INSERT INTO unlocks (usernode_pubkey, username, tx_id, amount, recipient, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (usernode_pubkey) DO NOTHING`,
        [pubkey, username, 'staging-demo-' + pubkey, UNLOCK_PRICE, UNLOCK_RECIPIENT]
      );
      return res.json({ unlocked: true, demo: true });
    }

    const { tx_id } = req.body || {};
    if (!tx_id) return res.status(400).json({ error: 'tx_id required' });

    // Independently fetch + verify the payment against the chain.
    const raw = await getTransaction({ txId: tx_id, recipient: UNLOCK_RECIPIENT });
    const tx = normalizeTx(raw || {});
    const v = verifyPayment(tx, { recipient: UNLOCK_RECIPIENT, price: UNLOCK_PRICE, sender: pubkey });
    if (!v.ok) return res.status(400).json({ error: 'Payment could not be verified', reason: v.reason });

    try {
      await pool.query(
        `INSERT INTO unlocks (usernode_pubkey, username, tx_id, amount, recipient, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW()) ON CONFLICT (usernode_pubkey) DO NOTHING`,
        [pubkey, username, tx.txId, Number(tx.amount) || UNLOCK_PRICE, UNLOCK_RECIPIENT]
      );
    } catch (e) {
      // tx_id UNIQUE violation → this payment was already claimed by a wallet.
      return res.status(400).json({ error: 'This payment has already been used' });
    }
    res.json({ unlocked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── My Profile (app-local display name + preferred language) ─────────────────
// Identity is the Usernode wallet. Username + wallet address are platform-owned
// and read-only here; only the app-local display name + language preference are
// writable. Keyed by usernode_pubkey in the private `profiles` table.

// Resolve the acting wallet for a profile request. Production: req.user only.
// local-dev / staging: fall back to a `viewer` param so the page works offline
// and the staging demo profile is reviewable without a real token.
function profileKey(req) {
  const fromUser = req.user && req.user.usernode_pubkey;
  if (fromUser) return fromUser;
  if (LOCAL_DEV || IS_STAGING) {
    const v = (req.body && req.body.viewer) || req.query.viewer;
    return (v && String(v)) || null;
  }
  return null;
}

// GET /api/me — caller identity + their profile row (upserts on first access
// so created_at is captured). Degrades to nulls when unauthenticated.
app.get('/api/me', async (req, res) => {
  try {
    const pubkey = profileKey(req);
    // The active Usernode Username comes from the verified JWT. In local-dev /
    // staging there is no token, so fall back to the username stored on the
    // viewer's profile row — this lets a wallet-less reviewer (?viewer=…) see the
    // username-keyed personalization the production session would get.
    let username = (req.user && req.user.username) || null;
    const id = (req.user && req.user.id) || null;
    let profile = null;
    if (pubkey && pool) {
      await pool.query(
        `INSERT INTO profiles (usernode_pubkey, username, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW()) ON CONFLICT (usernode_pubkey) DO NOTHING`,
        [pubkey, username]
      );
      // Keep the username↔address binding current when a verified username is present.
      if (username) {
        await pool.query(
          `UPDATE profiles SET username = $2, updated_at = NOW() WHERE usernode_pubkey = $1`,
          [pubkey, username]
        );
      }
      const { rows } = await pool.query(
        'SELECT username, display_name, preferred_lang, bio, prefs, created_at FROM profiles WHERE usernode_pubkey = $1',
        [pubkey]
      );
      const r = rows[0] || {};
      if (!username && (LOCAL_DEV || IS_STAGING)) username = r.username || null;
      profile = {
        display_name: r.display_name || null,
        preferred_lang: r.preferred_lang || null,
        bio: r.bio || null,
        prefs: r.prefs || null,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at || null),
      };
    }
    res.json({ id, username, usernode_pubkey: pubkey, profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/me/profile — update display name and/or preferred language.
app.put('/api/me/profile', async (req, res) => {
  try {
    const pubkey = profileKey(req);
    if (!pubkey) return res.status(400).json({ error: 'Link a Usernode wallet first' });

    const body = req.body || {};
    const hasName = body.display_name != null && body.display_name !== '';
    const hasLang = body.preferred_lang != null && body.preferred_lang !== '';
    const hasBio = body.bio != null;  // empty string is valid (clears bio)
    // prefs = per-username UI config (theme, last aggregation method) restored on
    // return. Accept a plain object only; ignore anything else.
    const hasPrefs = body.prefs != null && typeof body.prefs === 'object' && !Array.isArray(body.prefs);
    if (!hasName && !hasLang && !hasBio && !hasPrefs) return res.status(400).json({ error: 'Nothing to update' });
    if (hasName && !isValidDisplayName(body.display_name)) {
      return res.status(400).json({ error: 'Display name must be 3–20 letters, numbers, or underscores' });
    }
    if (hasLang && !isSupportedLang(body.preferred_lang)) {
      return res.status(400).json({ error: 'Unsupported language' });
    }
    if (hasBio && !isValidBio(body.bio)) {
      return res.status(400).json({ error: 'Bio must be 280 characters or fewer' });
    }
    if (!pool) return res.status(503).json({ error: 'Profiles are unavailable in this environment' });
    const username = (req.user && req.user.username) || null;
    // Empty string clears the bio (stored as null); non-empty sets it.
    const newBio = hasBio ? (body.bio === '' ? null : body.bio) : null;
    const newPrefs = hasPrefs ? JSON.stringify(body.prefs) : null;

    // Upsert; COALESCE / CASE keeps the existing value for fields not being changed.
    // $6 (hasBio) / $8 (hasPrefs) tell Postgres whether to apply that update at all,
    // distinguishing "not sent" (keep existing) from "sent" (overwrite).
    const { rows } = await pool.query(
      `INSERT INTO profiles (usernode_pubkey, username, display_name, preferred_lang, bio, prefs, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $7::jsonb, NOW(), NOW())
       ON CONFLICT (usernode_pubkey) DO UPDATE SET
         display_name = COALESCE($3, profiles.display_name),
         preferred_lang = COALESCE($4, profiles.preferred_lang),
         bio = CASE WHEN $6 THEN $5 ELSE profiles.bio END,
         prefs = CASE WHEN $8 THEN $7::jsonb ELSE profiles.prefs END,
         username = COALESCE(profiles.username, EXCLUDED.username),
         updated_at = NOW()
       RETURNING display_name, preferred_lang, bio, prefs, created_at`,
      [pubkey, username, hasName ? body.display_name : null, hasLang ? body.preferred_lang : null, newBio, hasBio, newPrefs, hasPrefs]
    );
    const r = rows[0] || {};
    res.json({
      ok: true,
      profile: {
        display_name: r.display_name || null,
        preferred_lang: r.preferred_lang || null,
        bio: r.bio || null,
        prefs: r.prefs || null,
        created_at: r.created_at instanceof Date ? r.created_at.toISOString() : (r.created_at || null),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Public user profiles ─────────────────────────────────────────────────────
// Returns the profile row + activity stats for any wallet address.
// Stats and history come from the in-memory indexer (no extra DB queries);
// they are filtered to elections visible to ?viewer=.
// Path starts with /api/public/ which is already in PUBLIC_PREFIXES — no auth needed.
app.get('/api/public/profiles/:addr', async (req, res) => {
  try {
    const addr = req.params.addr;
    const viewer = (req.query.viewer || '').toString() || null;

    let profileData = { username: null, display_name: null, bio: null };
    if (pool) {
      const { rows } = await pool.query(
        'SELECT username, display_name, bio FROM profiles WHERE usernode_pubkey = $1',
        [addr]
      );
      if (rows.length) {
        profileData = {
          username: rows[0].username || null,
          display_name: rows[0].display_name || null,
          bio: rows[0].bio || null,
        };
      }
    }

    const admin = indexer.isAdmin(viewer);
    const visible = indexer.visibleElections({ viewer, admin });
    const visibleEids = visible.map((el) => el.eid);
    const activity = indexer.activityByAddr(addr, visibleEids, { viewer, admin });

    res.json({
      usernode_pubkey: addr,
      username: profileData.username,
      display_name: profileData.display_name,
      bio: profileData.bio,
      stats: {
        results_submitted: activity.resultCount,
        elections: activity.electionCount,
        disputes_filed: activity.disputeCount,
        organizations: activity.organizations.length,
      },
      organizations: activity.organizations,
      history: activity.history,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// SPA shell. The public dashboard works without a wallet, so serve index.html
// for any GET (the auth gate above only protects non-GET / /api/* routes).
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Boot ─────────────────────────────────────────────────────────────────────
async function migrate() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chain_txs (
      tx_id TEXT PRIMARY KEY,
      from_addr TEXT,
      to_addr TEXT,
      amount NUMERIC DEFAULT 0,
      memo TEXT,
      created_at TIMESTAMPTZ,
      seen_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  // Permanent per-wallet unlock records (pay-to-unlock). Keyed on the payer's
  // wallet; tx_id UNIQUE prevents one payment being replayed by another wallet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unlocks (
      usernode_pubkey TEXT PRIMARY KEY,
      tx_id TEXT UNIQUE,
      amount INTEGER,
      recipient TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  // Payment + wallet data — private, so staging gets schema only (no rows).
  await pool.query(`COMMENT ON TABLE unlocks IS 'staging:private'`);
  // Off-chain image attachments (candidate avatars + station C1 scans).
  // PUBLIC table: these images are shown on the public dashboard, so a stranger
  // seeing every row is by design. No FK to candidates/stations on purpose —
  // rows may not be indexed yet when an organizer uploads at create time.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS attachments (
      eid TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      mime TEXT NOT NULL,
      bytes BYTEA NOT NULL,
      byte_size INTEGER NOT NULL,
      uploader_pubkey TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (eid, kind, ref_id)
    )`);
  // Off-chain per-station working tallies (inline vote entry in the workspace).
  // PUBLIC table: only aggregate vote counts shown on the dashboard, so a
  // stranger seeing every row is by design. No FK to candidates/stations on
  // purpose — rows may be written before the indexer has caught up, same as
  // attachments. Latest-write-wins per (eid, sid).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS work_tallies (
      eid TEXT NOT NULL,
      sid INTEGER NOT NULL,
      votes JSONB NOT NULL,
      author_pubkey TEXT,
      author_username TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (eid, sid)
    )`);
  // App-local user profiles: editable display name + preferred UI language,
  // keyed by the Usernode wallet. PRIVATE — it ties a wallet to a chosen
  // personal name and language (PII), like `unlocks`. Schema-only in staging;
  // seedStaging() inserts an obviously-fake demo row.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS profiles (
      usernode_pubkey TEXT PRIMARY KEY,
      username TEXT,
      display_name TEXT,
      preferred_lang TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`COMMENT ON TABLE profiles IS 'staging:private'`);
  // Ballot proofs — scanned ballot / count forms attached to a polling station.
  // PRIVATE: an uploaded ballot may carry personal/sensitive info, so a stranger
  // seeing every row would be a problem (joins `unlocks` + `profiles`). Staging
  // gets schema only; seedStaging() inserts obviously-fake rows. Bytes are served
  // only to the uploader / org operators / platform operator; the public sees a
  // validated-badge only. No FK (rows may precede indexing, like attachments).
  // `status` is 'draft' (mid-review) or 'submitted' (final). Latest-write-wins
  // per (eid, sid).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ballot_proofs (
      eid TEXT NOT NULL,
      sid INTEGER NOT NULL,
      mime TEXT,
      bytes BYTEA,
      byte_size INTEGER,
      page_count INTEGER,
      width INTEGER,
      height INTEGER,
      valid BOOLEAN DEFAULT FALSE,
      validation JSONB,
      status TEXT NOT NULL DEFAULT 'draft',
      uploader_pubkey TEXT,
      uploader_username TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (eid, sid)
    )`);
  await pool.query(`COMMENT ON TABLE ballot_proofs IS 'staging:private'`);
  // bio added in v2 of the profiles schema.
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT`);
  // v3 — username-as-identity: `profiles` is the authoritative username↔address
  // binding (resolve a Usernode Username to its wallet address for on-chain
  // reads), and `prefs` holds per-username UI config (theme, last aggregation
  // method) restored on return. Unique index is PARTIAL so the many rows that
  // predate a captured username (NULL) don't collide.
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS prefs JSONB`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_uniq ON profiles (username) WHERE username IS NOT NULL`);
  // Associate off-chain user data with the active Usernode Username (the wallet
  // address stays the cryptographic/replay key; username is the restore key).
  await pool.query(`ALTER TABLE unlocks ADD COLUMN IF NOT EXISTS username TEXT`);
  await pool.query(`ALTER TABLE attachments ADD COLUMN IF NOT EXISTS uploader_username TEXT`);
}

async function loadFromDb() {
  if (!pool) return;
  const { rows } = await pool.query('SELECT tx_id, from_addr, to_addr, amount, memo, created_at FROM chain_txs');
  for (const r of rows) {
    if (seen.has(r.tx_id)) continue;
    seen.add(r.tx_id);
    txLog.push({
      txId: r.tx_id, from: r.from_addr, to: r.to_addr,
      amount: Number(r.amount) || 0, memo: r.memo,
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    });
  }
}

// Staging-only demo image attachments so the avatar/C1 UI is visible in PR previews.
// Election data is seeded into the in-memory indexer by seedDemo(); only the
// off-chain attachments table needs direct DB rows here.
async function seedStaging() {
  if (!IS_STAGING || !pool) return;
  // Address the public-profile / user-page dapp.json tests reference by name.
  const root = 'ut1stagingdemo00000000000000000000000000';
  const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6aGFTEMLQkAF/tKAS/fz4YAAAAASUVORK5CYII=';
  const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNQTX6NFTEMLQkADGRcwcht3uAAAAAASUVORK5CYII=';
  const GRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMoLKzCihiGlgQA/HdXAZV6UO0AAAAASUVORK5CYII=';
  const GREEN_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNQWhCHFTEMLQkAE2xIAZF2mmQAAAAASUVORK5CYII=';
  const demoAtt = [
    // Generic demo-election avatars / C1 scan.
    ['demo-election', 'cand_avatar', 1, RED_PNG],
    ['demo-election', 'cand_avatar', 2, BLUE_PNG],
    ['demo-election', 'station_c1', 1, GRAY_PNG],
    // Pilpres 2024 (Indonesia) candidate-pair avatars (placeholders, not real photos).
    [PILPRES_EID, 'cand_avatar', 1, RED_PNG],
    [PILPRES_EID, 'cand_avatar', 2, BLUE_PNG],
    [PILPRES_EID, 'cand_avatar', 3, GREEN_PNG],
    // Closed election candidate avatars.
    ['demo-closed-election', 'cand_avatar', 1, RED_PNG],
    ['demo-closed-election', 'cand_avatar', 2, BLUE_PNG],
  ];
  for (const [eid, kind, refId, b64] of demoAtt) {
    const buf = Buffer.from(b64, 'base64');
    await pool.query(
      `INSERT INTO attachments (eid, kind, ref_id, mime, bytes, byte_size, uploader_pubkey, updated_at)
       VALUES ($1, $2, $3, 'image/png', $4, $5, $6, NOW())
       ON CONFLICT (eid, kind, ref_id) DO NOTHING`,
      [eid, kind, refId, buf, buf.length, root]
    );
  }

  // `profiles` is staging:private (schema-only in staging) → seed obviously-fake
  // rows so My Profile and public profile links are reviewable without real wallets.
  // `username` + `prefs` populate the username-keyed restore path (theme + last
  // aggregation method come back automatically on return).
  await pool.query(
    `INSERT INTO profiles (usernode_pubkey, username, display_name, preferred_lang, bio, prefs, created_at, updated_at)
     VALUES ($1, 'staging_demo_user', 'Staging_demo_user', 'en', 'Staging demo — election observer for Citizens Count', '{"theme":"dark","method":"verified"}'::jsonb, '2026-06-01T00:00:00.000Z', NOW())
     ON CONFLICT (usernode_pubkey) DO NOTHING`,
    [root]
  );
  // Second demo profile — keyed to the observer-one address used in demo elections,
  // so clicking their name in Disputes/Evidence shows a populated public profile.
  await pool.query(
    `INSERT INTO profiles (usernode_pubkey, username, display_name, preferred_lang, bio, prefs, created_at, updated_at)
     VALUES ($1, 'observer_one', 'Observer_One', 'en', 'Staging demo — observer profile for testing public profile links', '{"theme":"light","method":"latest"}'::jsonb, '2026-06-01T00:00:00.000Z', NOW())
     ON CONFLICT (usernode_pubkey) DO NOTHING`,
    [DEMO.obs1]
  );
  // Third demo profile — keyed to the Pollwatch Alliance owner, an ACTIVE org
  // with NO elections (the "registered but no election yet" case). Its public
  // profile shows a populated Organizations section with zero election activity.
  await pool.query(
    `INSERT INTO profiles (usernode_pubkey, username, display_name, preferred_lang, bio, created_at, updated_at)
     VALUES ($1, 'pollwatch_owner', 'Pollwatch_Owner', 'en', 'Staging demo — organizer who has registered an org but not yet created an election', '2026-06-01T00:00:00.000Z', NOW())
     ON CONFLICT (usernode_pubkey) DO NOTHING`,
    [DEMO.pollwatch]
  );
  // Fourth demo profile — keyed to the Pemilu Watch (Indonesia) org owner, so the
  // 2024 Pilpres presentation election has a populated organizer profile. Clearly
  // fictional; NOT Indonesia's real election commission.
  await pool.query(
    `INSERT INTO profiles (usernode_pubkey, username, display_name, preferred_lang, bio, created_at, updated_at)
     VALUES ($1, 'pemilu_watch_id', 'Pemilu_Watch_ID', 'en', 'Staging demo — independent election-watch organizer (fictional)', '2026-06-01T00:00:00.000Z', NOW())
     ON CONFLICT (usernode_pubkey) DO NOTHING`,
    [DEMO.orgID]
  );
  // Demo unlock row keyed to the staging demo user's username, so the unlock
  // entitlement restore (live results stay unlocked on return) is reviewable.
  await pool.query(
    `INSERT INTO unlocks (usernode_pubkey, username, tx_id, amount, recipient, created_at)
     VALUES ($1, 'staging_demo_user', 'staging-demo-unlock', $2, $3, NOW())
     ON CONFLICT (usernode_pubkey) DO NOTHING`,
    [root, UNLOCK_PRICE, UNLOCK_RECIPIENT || root]
  );
  // Working-tally rows (off-chain) so the workspace upper bars + the dashboard
  // "Working tally" section render non-empty in PR previews / proposal checks
  // without a tester typing first. Obviously-fake counts, authored by the
  // staging demo root address. Seeds two stations each for the Pilpres demo
  // and the generic demo-election. Idempotent — replaces the old client-only
  // maybeSeedDemoInline() seeding.
  const demoWork = [
    [PILPRES_EID, 1, { evan: 412, salah: 286, circle: 173 }],
    [PILPRES_EID, 2, { evan: 168, salah: 503, circle: 241 }],
    ['demo-election', 1, { evan: 412, salah: 286, circle: 173 }],
    ['demo-election', 2, { evan: 168, salah: 503, circle: 241 }],
  ];
  for (const [eid, sid, votes] of demoWork) {
    await pool.query(
      `INSERT INTO work_tallies (eid, sid, votes, author_pubkey, author_username, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, 'staging_demo_user', NOW())
       ON CONFLICT (eid, sid) DO NOTHING`,
      [eid, sid, JSON.stringify(votes), root]
    );
  }

  // Ballot proofs (off-chain, staging:private → schema-only in staging, so seed
  // explicitly or the badge + review UI render empty). Obviously fake. Covers the
  // three reviewable states: a SUBMITTED+VALID proof (public "validated" badge +
  // authorized-viewer image), a DRAFT proof (in-app review/edit-before-submit),
  // and a deliberately-INVALID draft (the "doesn't look like a usable scan" path
  // with Submit disabled). Uploaders span the observer + operator auth paths.
  // GRAY_PNG is a tiny placeholder — real uploads must pass validateBallotProof.
  const TINY_BLOB = 'iVBORw0KGgo='; // ~8 bytes — stands in for a rejected scan.
  const demoProofs = [
    // [eid, sid, status, valid, b64, validation, uploaderPubkey, uploaderUsername]
    [PILPRES_EID, 1, 'submitted', true, GRAY_PNG, { ok: true, info: { kind: 'image', note: 'Staging demo — synthetic ballot scan' } }, DEMO.obs1, 'observer_one'],
    ['demo-election', 1, 'submitted', true, GRAY_PNG, { ok: true, info: { kind: 'image', note: 'Staging demo — synthetic ballot scan' } }, DEMO.orgID, 'pemilu_watch_id'],
    ['demo-election', 2, 'draft', true, GRAY_PNG, { ok: true, info: { kind: 'image', note: 'Staging demo — draft awaiting review' } }, DEMO.obs1, 'observer_one'],
    ['demo-election', 3, 'draft', false, TINY_BLOB, { ok: false, error: 'Scan resolution too low (needs a clearer photo)', info: { kind: 'image' } }, DEMO.obs1, 'observer_one'],
  ];
  for (const [eid, sid, status, valid, b64, validation, up, upName] of demoProofs) {
    const buf = Buffer.from(b64, 'base64');
    await pool.query(
      `INSERT INTO ballot_proofs (eid, sid, mime, bytes, byte_size, valid, validation, status, uploader_pubkey, uploader_username, updated_at)
       VALUES ($1, $2, 'image/png', $3, $4, $5, $6::jsonb, $7, $8, $9, NOW())
       ON CONFLICT (eid, sid) DO NOTHING`,
      [eid, sid, buf, buf.length, valid, JSON.stringify(validation), status, up, upName]
    );
  }
}

async function start() {
  await migrate();
  await loadFromDb();
  seedDemo();
  await seedStaging();
  await pollOnce();
  // No explorer/node upstream → the indexer can't ingest and the /explorer-api
  // proxy has nothing to forward to. This is no longer a silent log-only state:
  // /__quickcount/config (and /api/public/config) report chainConfigured=false,
  // which the SPA surfaces as a persistent banner on the Orgs/Admin screens and
  // a neutral "submitted — awaiting on-chain sync" notice instead of a false
  // success toast. We still log here so operators see it in container logs.
  if (MOCK_TX_FLOW && !LOCAL_DEV) {
    console.log(
      '[QuickCount] running in self-contained local-ingest mode (MOCK_TX_FLOW) — ' +
      'submissions are recorded directly into the event log via /__mock/submit and ' +
      'persisted to chain_txs when DATABASE_URL is set; no chain broadcast/read-back. ' +
      'Set MOCK_TX_FLOW=false to restore real-chain reads.'
    );
  } else if (source.backend === 'none' && !LOCAL_DEV) {
    console.warn(
      '[QuickCount] WARNING: no chain read source configured — set EXPLORER_API_URL ' +
      'or NODE_RPC_URL. On-chain transactions will broadcast but the indexer will not ' +
      'ingest them (registered orgs will not appear and admin stats stay at 0). The UI ' +
      'now shows a persistent "on-chain sync not configured" banner via chainConfigured=false.'
    );
  }
  // Local-dev keeps a snappy 2s loop; every other environment uses the
  // configurable TIMER_DURATION_MS cadence (default 6s, floored at 1000ms).
  const interval = LOCAL_DEV ? 2000 : TIMER_DURATION_MS;
  setInterval(() => pollOnce().catch((e) => console.error('pollOnce failed:', e.message)), interval);
  app.listen(PORT, () => console.log(
    `Quick Count listening on :${PORT}` + (LOCAL_DEV ? ' (local-dev)' : '') + (IS_STAGING ? ' (staging)' : '') +
    ` — chain source: ${source.backend}` + (source.endpoint ? ` (${source.endpoint})` : '')
  ));
}

// Only auto-start when run directly (`node server.js`); stays importable from
// tests, which exercise `app` without booting the poller / listener.
if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = {
  app, indexer, buildDemoTxs, resyncFromChain, source, PILPRES_EID,
  sanitizeWorkVotes, loadWorkTally, migrate,
  // Live-publishing broker (exposed for unit tests).
  sse: { subscribe: sseSubscribe, publish: ssePublish, clients: sseClients, count: () => sseCount },
};

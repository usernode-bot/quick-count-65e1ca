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
const { makeSource } = require('./lib/txsource');

let Pool = null;
try { ({ Pool } = require('pg')); } catch { /* pg optional in pure-memory mode */ }

// ── Configuration ───────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes('--local-dev') || process.env.APP_MODE === 'local-dev';
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const IS_DEMO = LOCAL_DEV || IS_STAGING; // seed obviously-fake data so every screen renders
const PORT = process.env.PORT || 3000;
const NODE_RPC_URL = process.env.NODE_RPC_URL || '';
const TREASURY_ADDR = process.env.TREASURY_ADDR || 'ut1treasuryquickcount00000000000000000000';
const ORG_FEE = Number(process.env.ORG_FEE) || 100;

// Demo personas (local-dev persona switcher + admin).
const DEMO = {
  admin: 'ut1demoadmin000000000000000000000000000000',
  orgA: 'ut1democitizenscount0000000000000000000000',
  orgB: 'ut1demounpaidorg000000000000000000000000000',
  obs1: 'ut1demoobserverone000000000000000000000000',
  obs2: 'ut1demoobservertwo000000000000000000000000',
  obs3: 'ut1demoobserverthree00000000000000000000000',
};
const ADMIN_ADDRS = (process.env.ADMIN_ADDRS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (IS_DEMO) ADMIN_ADDRS.push(DEMO.admin);

const pool = (Pool && process.env.DATABASE_URL)
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;

const indexer = new QuickCountIndexer({ treasury: TREASURY_ADDR, orgFee: ORG_FEE, adminAddrs: ADMIN_ADDRS });
const source = makeSource({ localDev: LOCAL_DEV, nodeUrl: NODE_RPC_URL });

// In-memory transaction log (source for every rebuild) and dedupe set.
const txLog = [];
const seen = new Set();
const watched = new Map(); // address -> cursor
watched.set(TREASURY_ADDR, null);

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

async function pollOnce() {
  let added = false;
  if (LOCAL_DEV) {
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
  return added;
}

// ── Demo seed (obviously fake; only in local-dev / staging) ──────────────────
function evHash(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function buildDemoTxs() {
  let t = Date.parse('2026-06-19T08:00:00.000Z');
  const at = () => new Date(t += 60000).toISOString();
  const mk = (txId, from, to, amount, env) => ({ txId, from, to, amount, memo: memo.encode(env), createdAt: at() });
  const eid = 'demo_el_general';
  const ev1 = evHash('Staging demo — tally sheet station 1');
  const ev2 = evHash('Staging demo — tally sheet station 3');

  const txs = [
    // Organizations — one pays the fee (active), one does not (pending).
    mk('demo_org_a', DEMO.orgA, TREASURY_ADDR, ORG_FEE, memo.orgMemo('Staging demo — Citizens Count', 'Demo Republic')),
    mk('demo_org_b', DEMO.orgB, TREASURY_ADDR, 0, memo.orgMemo('Staging demo — Unpaid Org', 'Demo Republic')),
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

// Local-dev mock chain endpoints — mounted BEFORE the auth gate, 404 otherwise.
if (LOCAL_DEV) {
  app.post('/__mock/submit', async (req, res) => {
    const { from, to, amount, memo: m } = req.body || {};
    if (!from) return res.status(400).json({ error: 'from required' });
    const tx = mock.append({ from, to: to || from, amount: amount || 0, memo: m });
    await pollOnce();
    res.json({ txId: tx.txId, ok: true });
  });
  app.get('/__mock/transactions', (_req, res) => res.json({ transactions: mock.all() }));
  app.post('/__mock/reset', async (_req, res) => { mock.reset(); txLog.length = 0; seen.clear(); rebuild(); res.json({ ok: true }); });
  app.post('/__mock/seed', async (_req, res) => { seedDemo(); await pollOnce(); res.json({ ok: true, txs: mock.size() }); });
}

// Platform-compatible auth gate: verify a JWT if present and deny-by-default for
// non-GET / /api/* routes. The Quick Count read endpoints live under
// /__quickcount/* (GET) and are intentionally public — the server is read-only
// and the chain is already public.
const JWT_SECRET = process.env.JWT_SECRET;
const PUBLIC_API_PATHS = new Set(['/health']);
const PUBLIC_PREFIXES = ['/__quickcount/', '/__mock/', '/explorer-api/'];
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

// Public config for the frontend.
app.get('/__quickcount/config', (_req, res) => {
  const personas = LOCAL_DEV ? [
    { label: 'Org — Citizens Count', addr: DEMO.orgA },
    { label: 'Observer One', addr: DEMO.obs1 },
    { label: 'Observer Three (Station B)', addr: DEMO.obs3 },
    { label: 'Platform Admin', addr: DEMO.admin },
    { label: 'Fresh wallet', addr: null },
  ] : null;
  res.json({
    localDev: LOCAL_DEV, staging: IS_STAGING, demo: IS_DEMO,
    treasury: TREASURY_ADDR, orgFee: ORG_FEE, adminAddrs: ADMIN_ADDRS,
    methods: require('./lib/aggregate').METHODS, personas,
  });
});

// Visibility-aware app state. `viewer` is the connected wallet (or empty).
app.get('/__quickcount/state', (req, res) => {
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
    }
    res.json({ role, elections, detail, method });
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

async function start() {
  await migrate();
  await loadFromDb();
  seedDemo();
  await pollOnce();
  const interval = LOCAL_DEV ? 2000 : 4000;
  setInterval(() => pollOnce().catch((e) => console.error('pollOnce failed:', e.message)), interval);
  app.listen(PORT, () => console.log(`Quick Count listening on :${PORT}` + (LOCAL_DEV ? ' (local-dev)' : '') + (IS_STAGING ? ' (staging)' : '')));
}

start().catch((err) => { console.error(err); process.exit(1); });

module.exports = { app, indexer, buildDemoTxs };

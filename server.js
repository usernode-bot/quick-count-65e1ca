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
const { makeSource, getTransaction } = require('./lib/txsource');
const { verifyPayment } = require('./lib/unlock');
const { isKind, validateImageUpload } = require('./lib/attach');
const { isValidDisplayName, isValidBio, isSupportedLang } = require('./lib/profile');

let Pool = null;
try { ({ Pool } = require('pg')); } catch { /* pg optional in pure-memory mode */ }

// ── Configuration ───────────────────────────────────────────────────────────
const LOCAL_DEV = process.argv.includes('--local-dev') || process.env.APP_MODE === 'local-dev';
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const IS_DEMO = LOCAL_DEV || IS_STAGING; // seed obviously-fake data so every screen renders
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
const source = makeSource({ localDev: LOCAL_DEV, nodeUrl: NODE_RPC_URL, explorerUrl: EXPLORER_API_URL, chainId: CHAIN_ID });

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
  const eid = 'demo-election';
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

// Stable fallback sender for mock submissions that omit `from`. The hosted
// bridge's mock mode derives the sender from its own configured identity and
// may POST only { to, amount, memo }; the app's own QCMock always sends `from`.
const MOCK_FALLBACK_ADDR = 'ut1mockwallet000000000000000000000000000000';

// Local-dev mock chain endpoints — mounted BEFORE the auth gate, 404 otherwise.
if (LOCAL_DEV) {
  // Probed by the hosted bridge to decide whether to enter mock mode. A 200
  // here makes the bridge route transactions through /__mock/* instead of
  // failing with "Mock API not enabled". Only mounted in local-dev, so it 404s
  // (mock mode off) under staging/production, exactly as intended.
  app.get('/__mock/enabled', (_req, res) => res.json({ enabled: true }));
  app.post('/__mock/submit', async (req, res) => {
    const { from, to, amount, memo: m } = req.body || {};
    // `from` defaults to a stable mock address so the hosted bridge's mock
    // submit (which omits it) works end-to-end; QCMock still sends its own.
    const sender = from || MOCK_FALLBACK_ADDR;
    const tx = mock.append({ from: sender, to: to || sender, amount: amount || 0, memo: m });
    await pollOnce();
    res.json({ txId: tx.txId, ok: true });
  });
  app.get('/__mock/transactions', (_req, res) => res.json({ transactions: mock.all() }));
  app.post('/__mock/reset', async (_req, res) => { mock.reset(); txLog.length = 0; seen.clear(); rebuild(); res.json({ ok: true }); });
  app.post('/__mock/seed', async (_req, res) => { seedDemo(); await pollOnce(); res.json({ ok: true, txs: mock.size() }); });
} else {
  // Outside local-dev the mock surface must be genuinely absent: explicitly
  // 404 every /__mock/* path so the SPA catch-all (app.get('*')) can't answer
  // the bridge's GET /__mock/enabled probe with a 200 index.html — which would
  // wrongly switch the bridge into mock mode in staging/production.
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
    // Chain read config for the client confirmation poll. The browser builds
    // <explorerApiBase>/<chainId>/transactions; both are auth-exempt.
    chainId: CHAIN_ID, explorerApiBase: EXPLORER_API_BASE,
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
    unlock: {
      enabled: UNLOCK_ENABLED,
      recipient: UNLOCK_RECIPIENT || null,
      price: UNLOCK_PRICE,
    },
    // Chain read config so the public dashboard can confirm the unlock payment
    // against the same explorer proxy the main app uses.
    chainId: CHAIN_ID, explorerApiBase: EXPLORER_API_BASE,
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

    const { mime, data_base64 } = req.body || {};
    if (typeof data_base64 !== 'string' || !data_base64) {
      return res.status(400).json({ error: 'data_base64 required' });
    }
    let buf;
    try { buf = Buffer.from(data_base64, 'base64'); } catch { buf = null; }
    const check = validateImageUpload(mime, buf);
    if (!check.ok) return res.status(check.status || 400).json({ error: check.error });

    await pool.query(
      `INSERT INTO attachments (eid, kind, ref_id, mime, bytes, byte_size, uploader_pubkey, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (eid, kind, ref_id)
       DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
                     byte_size = EXCLUDED.byte_size, uploader_pubkey = EXCLUDED.uploader_pubkey,
                     updated_at = NOW()`,
      [eid, kind, refId, mime, buf, buf.length, (req.user && req.user.usernode_pubkey) || null]
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

    const candidates = d.candidates.map((c) => ({
      cid: c.cid, name: c.name,
      avatar: hasAvatar.has(Number(c.cid)) ? avatarUrl(Number(c.cid)) : null,
    }));

    // Pay-to-unlock gate. The auth middleware has already populated req.user
    // from any token, even on this public path, so one endpoint serves both
    // locked (anonymous / unpaid) and unlocked (paid wallet) viewers.
    const unlocked = await walletUnlocked(req.user && req.user.usernode_pubkey);

    const base = {
      election: { eid: d.election.eid, name: d.election.name, root_pubkey: d.election.orgAddr },
      candidates,
      reporting: d.reporting,
      lastUpdated: d.lastUpdated,
      locked: !unlocked,
    };

    if (unlocked) {
      const stations = d.stations.map((s) => ({
        sid: s.sid, name: s.name, reported: s.reported,
        votes: s.votes, tot: s.tot, inv: s.inv, at: s.at,
        c1: hasC1.has(s.sid) ? c1Url(s.sid) : null,
      }));
      return res.json(Object.assign(base, { stations, tally: d.tally }));
    }

    // Locked: withhold vote figures so the blur cannot be defeated in dev-tools.
    // Keep structure (names, reported flag, reporting counts) for the placeholder UI.
    const lockedStations = d.stations.map((s) => ({
      sid: s.sid, name: s.name, reported: s.reported,
      votes: null, tot: null, inv: null, at: null,
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
    if (!pubkey) return res.status(400).json({ error: 'Link a Usernode wallet first' });
    if (!UNLOCK_ENABLED) return res.status(503).json({ error: 'Unlocking is not configured' });

    // Already paid → idempotent success (never charge twice).
    if (await walletUnlocked(pubkey)) return res.json({ unlocked: true });

    if (IS_STAGING) {
      // No live chain in staging — record a clearly-labelled demo unlock so the
      // unlocked view is reviewable without a real payment.
      await pool.query(
        `INSERT INTO unlocks (usernode_pubkey, tx_id, amount, recipient, created_at)
         VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (usernode_pubkey) DO NOTHING`,
        [pubkey, 'staging-demo-' + pubkey, UNLOCK_PRICE, UNLOCK_RECIPIENT]
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
        `INSERT INTO unlocks (usernode_pubkey, tx_id, amount, recipient, created_at)
         VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (usernode_pubkey) DO NOTHING`,
        [pubkey, tx.txId, Number(tx.amount) || UNLOCK_PRICE, UNLOCK_RECIPIENT]
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
    const username = (req.user && req.user.username) || null;
    const id = (req.user && req.user.id) || null;
    let profile = null;
    if (pubkey && pool) {
      await pool.query(
        `INSERT INTO profiles (usernode_pubkey, username, created_at, updated_at)
         VALUES ($1, $2, NOW(), NOW()) ON CONFLICT (usernode_pubkey) DO NOTHING`,
        [pubkey, username]
      );
      const { rows } = await pool.query(
        'SELECT display_name, preferred_lang, bio, created_at FROM profiles WHERE usernode_pubkey = $1',
        [pubkey]
      );
      const r = rows[0] || {};
      profile = {
        display_name: r.display_name || null,
        preferred_lang: r.preferred_lang || null,
        bio: r.bio || null,
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
    if (!hasName && !hasLang && !hasBio) return res.status(400).json({ error: 'Nothing to update' });
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

    // Upsert; COALESCE / CASE keeps the existing value for fields not being changed.
    // $6 (hasBio boolean) tells Postgres whether to apply the bio update at all,
    // distinguishing "not sent" (keep existing) from "sent empty" (clear to null).
    const { rows } = await pool.query(
      `INSERT INTO profiles (usernode_pubkey, username, display_name, preferred_lang, bio, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (usernode_pubkey) DO UPDATE SET
         display_name = COALESCE($3, profiles.display_name),
         preferred_lang = COALESCE($4, profiles.preferred_lang),
         bio = CASE WHEN $6 THEN $5 ELSE profiles.bio END,
         username = COALESCE(profiles.username, EXCLUDED.username),
         updated_at = NOW()
       RETURNING display_name, preferred_lang, bio, created_at`,
      [pubkey, username, hasName ? body.display_name : null, hasLang ? body.preferred_lang : null, newBio, hasBio]
    );
    const r = rows[0] || {};
    res.json({
      ok: true,
      profile: {
        display_name: r.display_name || null,
        preferred_lang: r.preferred_lang || null,
        bio: r.bio || null,
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

    const visible = indexer.visibleElections({ viewer, admin: indexer.isAdmin(viewer) });
    const visibleEids = visible.map((el) => el.eid);
    const activity = indexer.activityByAddr(addr, visibleEids);

    res.json({
      usernode_pubkey: addr,
      username: profileData.username,
      display_name: profileData.display_name,
      bio: profileData.bio,
      stats: {
        results_submitted: activity.resultCount,
        elections: activity.electionCount,
        disputes_filed: activity.disputeCount,
      },
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
  // bio added in v2 of the profiles schema.
  await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio TEXT`);
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
  const root = 'ut1demo00000000000000000000000000000000';
  const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6aGFTEMLQkAF/tKAS/fz4YAAAAASUVORK5CYII=';
  const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNQTX6NFTEMLQkADGRcwcht3uAAAAAASUVORK5CYII=';
  const GRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMoLKzCihiGlgQA/HdXAZV6UO0AAAAASUVORK5CYII=';
  const demoAtt = [
    ['cand_avatar', 1, RED_PNG],
    ['cand_avatar', 2, BLUE_PNG],
    ['station_c1', 1, GRAY_PNG],
  ];
  for (const [kind, refId, b64] of demoAtt) {
    const buf = Buffer.from(b64, 'base64');
    await pool.query(
      `INSERT INTO attachments (eid, kind, ref_id, mime, bytes, byte_size, uploader_pubkey, updated_at)
       VALUES ('demo-election', $1, $2, 'image/png', $3, $4, $5, NOW())
       ON CONFLICT (eid, kind, ref_id) DO NOTHING`,
      [kind, refId, buf, buf.length, root]
    );
  }

  // `profiles` is staging:private (schema-only in staging) → seed obviously-fake
  // rows so My Profile and public profile links are reviewable without real wallets.
  await pool.query(
    `INSERT INTO profiles (usernode_pubkey, username, display_name, preferred_lang, bio, created_at, updated_at)
     VALUES ($1, 'Staging demo user', 'Staging_demo_user', 'en', 'Staging demo — election observer for Citizens Count', '2026-06-01T00:00:00.000Z', NOW())
     ON CONFLICT (usernode_pubkey) DO NOTHING`,
    [root]
  );
  // Second demo profile — keyed to the observer-one address used in demo elections,
  // so clicking their name in Disputes/Evidence shows a populated public profile.
  await pool.query(
    `INSERT INTO profiles (usernode_pubkey, username, display_name, preferred_lang, bio, created_at, updated_at)
     VALUES ($1, 'observer_one', 'Observer_One', 'en', 'Staging demo — observer profile for testing public profile links', '2026-06-01T00:00:00.000Z', NOW())
     ON CONFLICT (usernode_pubkey) DO NOTHING`,
    [DEMO.obs1]
  );
}

async function start() {
  await migrate();
  await loadFromDb();
  seedDemo();
  await seedStaging();
  await pollOnce();
  const interval = LOCAL_DEV ? 2000 : 4000;
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

module.exports = { app, indexer, buildDemoTxs, resyncFromChain, source };

const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const txsource = require('./lib/txsource');
const { normalizeTx, applyTx } = require('./lib/indexer');
const { latestPerStation, computeTally, reporting } = require('./lib/aggregate');
const { verifyPayment } = require('./lib/unlock');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// ── Pay-to-unlock config ─────────────────────────────────────────────────────
// The recipient address and price are configured via dapp.json secrets. The
// network is currently a test/mock-token network; switching to mainnet is just
// setting UNLOCK_RECIPIENT_ADDRESS to a real wallet — no code changes.
const UNLOCK_RECIPIENT = process.env.UNLOCK_RECIPIENT_ADDRESS || '';
const UNLOCK_PRICE = Math.max(0, parseInt(process.env.UNLOCK_PRICE_TOKENS || '0', 10) || 0);
const UNLOCK_ENABLED = !!UNLOCK_RECIPIENT;

// Paths that stay open without authentication.
const PUBLIC_API_PATHS = new Set(['/health']);
// Public path prefixes that bypass the JWT gate. `/explorer-api/*` is the
// platform's transparent explorer proxy. `/api/public/*` serves the public
// live dashboard, which logged-out visitors must be able to read.
const PUBLIC_PREFIXES = ['/explorer-api/', '/api/public/'];

app.use(express.json());

// Verify platform-issued JWT if present, then enforce auth on anything not
// explicitly marked public.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Read-model store (PgStore) used by the indexer ──────────────────────────
// All writes are insert-if-absent so replaying a tx_id is a no-op.
const store = {
  async getElection(eid) {
    const { rows } = await pool.query('SELECT eid, name, root_pubkey, creator_pubkey FROM elections WHERE eid = $1', [eid]);
    return rows[0] || null;
  },
  async putElection(r) {
    await pool.query(
      `INSERT INTO elections (eid, name, root_pubkey, creator_pubkey, tx_id, created_at)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, NOW()))
       ON CONFLICT (eid) DO NOTHING`,
      [r.eid, r.name, r.root_pubkey, r.creator_pubkey, r.tx_id, r.created_at]
    );
  },
  async putCandidate(r) {
    await pool.query(
      `INSERT INTO candidates (eid, cid, name, tx_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (eid, cid) DO NOTHING`,
      [r.eid, r.cid, r.name, r.tx_id]
    );
  },
  async putStation(r) {
    await pool.query(
      `INSERT INTO stations (eid, sid, name, tx_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (eid, sid) DO NOTHING`,
      [r.eid, r.sid, r.name, r.tx_id]
    );
  },
  async putResult(r) {
    await pool.query(
      `INSERT INTO results (tx_id, eid, sid, submitter_pubkey, votes, tot, inv, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, COALESCE($8::timestamptz, NOW()))
       ON CONFLICT (tx_id) DO NOTHING`,
      [r.tx_id, r.eid, r.sid, r.submitter_pubkey, JSON.stringify(r.votes || {}), r.tot, r.inv, r.created_at]
    );
  },
};

// Has this wallet paid to unlock? Unlock is global per wallet and permanent.
async function walletUnlocked(pubkey) {
  if (!pubkey) return false;
  const { rows } = await pool.query('SELECT 1 FROM unlocks WHERE usernode_pubkey = $1', [pubkey]);
  return rows.length > 0;
}

// ── Indexer poll loop ───────────────────────────────────────────────────────
async function pollOnce() {
  const ws = (await pool.query('SELECT address, cursor FROM watched_addresses')).rows;
  for (const w of ws) {
    let txs = [];
    try {
      txs = await txsource.listTransactions({ account: w.address, sinceCursor: w.cursor });
    } catch { continue; }
    if (!Array.isArray(txs) || !txs.length) continue;
    const norm = txs.map(normalizeTx).filter((t) => t.txId);
    // Apply oldest-first so an election is indexed before its children.
    norm.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    let cursor = w.cursor;
    for (const t of norm) {
      try { await applyTx(store, t); } catch (e) { console.error('applyTx failed:', e.message); }
      if (t.createdAt && (!cursor || t.createdAt > cursor)) cursor = t.createdAt;
    }
    if (cursor && cursor !== w.cursor) {
      await pool.query('UPDATE watched_addresses SET cursor = $2 WHERE address = $1', [w.address, cursor]);
    }
  }
}

// ── API ─────────────────────────────────────────────────────────────────────

// Public config (staging banner, poll hint, unlock pricing). Public so the
// dashboard can read it before the viewer authenticates.
app.get('/api/public/config', (_req, res) => {
  res.json({
    staging: IS_STAGING,
    unlock: {
      enabled: UNLOCK_ENABLED,
      recipient: UNLOCK_RECIPIENT || null,
      price: UNLOCK_PRICE,
    },
  });
});

// Authenticated: who am I (header / wallet hint for the app shell).
app.get('/api/me', (req, res) => {
  res.json({ username: req.user.username, usernode_pubkey: req.user.usernode_pubkey || null, staging: IS_STAGING });
});

// Authenticated: register a newly-created election's root address so the
// indexer starts watching it. Carries NO election content — the chain remains
// the source of truth.
app.post('/api/elections/track', async (req, res) => {
  try {
    const { root_pubkey, tx_id } = req.body || {};
    if (!root_pubkey) return res.status(400).json({ error: 'root_pubkey required' });
    if (req.user.usernode_pubkey && req.user.usernode_pubkey !== root_pubkey) {
      return res.status(403).json({ error: 'root_pubkey does not match your linked wallet' });
    }
    await pool.query(
      `INSERT INTO watched_addresses (address, cursor, added_at) VALUES ($1, NULL, NOW())
       ON CONFLICT (address) DO NOTHING`,
      [root_pubkey]
    );
    pollOnce().catch(() => {}); // kick an immediate index pass
    res.json({ ok: true, tx_id: tx_id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: list elections with counts.
app.get('/api/public/elections', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.eid, e.name, e.created_at,
        (SELECT COUNT(*) FROM candidates c WHERE c.eid = e.eid) AS candidate_count,
        (SELECT COUNT(*) FROM stations s WHERE s.eid = e.eid) AS station_count,
        (SELECT COUNT(DISTINCT r.sid) FROM results r WHERE r.eid = e.eid) AS reported_count
      FROM elections e
      ORDER BY e.created_at DESC NULLS LAST, e.eid
    `);
    res.json({
      elections: rows.map((r) => ({
        eid: r.eid,
        name: r.name,
        candidate_count: Number(r.candidate_count),
        station_count: Number(r.station_count),
        reported_count: Number(r.reported_count),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public: election detail with Latest-Submission aggregation.
app.get('/api/public/elections/:eid', async (req, res) => {
  try {
    const eid = req.params.eid;
    const el = (await pool.query('SELECT eid, name, root_pubkey, created_at FROM elections WHERE eid = $1', [eid])).rows[0];
    if (!el) return res.status(404).json({ error: 'not found' });

    const candidates = (await pool.query('SELECT cid, name FROM candidates WHERE eid = $1 ORDER BY cid', [eid])).rows
      .map((c) => ({ cid: Number(c.cid), name: c.name }));
    const stations = (await pool.query('SELECT sid, name FROM stations WHERE eid = $1 ORDER BY sid', [eid])).rows
      .map((s) => ({ sid: Number(s.sid), name: s.name }));
    const results = (await pool.query(
      'SELECT sid, tx_id, submitter_pubkey, votes, tot, inv, created_at FROM results WHERE eid = $1', [eid]
    )).rows.map((r) => ({
      sid: Number(r.sid),
      tx_id: r.tx_id,
      submitter_pubkey: r.submitter_pubkey,
      votes: r.votes || {},
      tot: r.tot,
      inv: r.inv,
      created_at: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    }));

    const latest = latestPerStation(results);
    const tally = computeTally(candidates, latest);
    const prog = reporting(stations, latest);
    const perStation = stations.map((s) => {
      const r = latest.get(s.sid);
      return {
        sid: s.sid,
        name: s.name,
        reported: !!r,
        votes: r ? r.votes : null,
        tot: r ? r.tot : null,
        inv: r ? r.inv : null,
        at: r ? r.created_at : null,
        submitter: r ? r.submitter_pubkey : null,
      };
    });
    let lastUpdated = null;
    for (const r of results) if (r.created_at && (!lastUpdated || r.created_at > lastUpdated)) lastUpdated = r.created_at;

    // Pay-to-unlock gate. The auth middleware has already populated req.user
    // from any token, even on this public path, so one endpoint serves both
    // locked (anonymous / unpaid) and unlocked (paid wallet) viewers.
    const unlocked = await walletUnlocked(req.user && req.user.usernode_pubkey);

    const base = {
      election: { eid: el.eid, name: el.name, root_pubkey: el.root_pubkey },
      candidates,
      reporting: prog,
      lastUpdated,
      locked: !unlocked,
    };

    if (unlocked) {
      return res.json(Object.assign(base, { stations: perStation, tally }));
    }

    // Locked: withhold every vote figure so the blur cannot be defeated in
    // dev-tools. Keep structure (names, reported flag, reporting counts) so the
    // dashboard can render a believable blurred placeholder and the submit flow
    // (which only needs candidates/stations/root_pubkey) keeps working.
    const lockedStations = perStation.map((s) => ({
      sid: s.sid, name: s.name, reported: s.reported,
      votes: null, tot: null, inv: null, at: null, submitter: null,
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
    const raw = await txsource.getTransaction({ txId: tx_id, recipient: UNLOCK_RECIPIENT });
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

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page. The public dashboard lives at /dashboard.html and is served
// by express.static above (a GET, non-/api path) without auth.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated. The public live dashboard is at <code>/dashboard.html</code>.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS elections (
      eid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_pubkey TEXT,
      creator_pubkey TEXT,
      tx_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS candidates (
      eid TEXT NOT NULL,
      cid INTEGER NOT NULL,
      name TEXT NOT NULL,
      tx_id TEXT,
      PRIMARY KEY (eid, cid)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS stations (
      eid TEXT NOT NULL,
      sid INTEGER NOT NULL,
      name TEXT NOT NULL,
      tx_id TEXT,
      PRIMARY KEY (eid, sid)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS results (
      tx_id TEXT PRIMARY KEY,
      eid TEXT NOT NULL,
      sid INTEGER NOT NULL,
      submitter_pubkey TEXT,
      votes JSONB NOT NULL DEFAULT '{}'::jsonb,
      tot INTEGER,
      inv INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS results_eid_sid_idx ON results (eid, sid)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watched_addresses (
      address TEXT PRIMARY KEY,
      cursor TEXT,
      added_at TIMESTAMPTZ DEFAULT NOW()
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
}

// Staging-only demo data so the public dashboard isn't empty in PR previews.
// All rows are obviously fake and never reference real users. Strict no-op
// outside staging. Writes directly into the read model (the one sanctioned
// bypass of the indexer, for demo only — there is no live chain in staging).
async function seedStaging() {
  if (!IS_STAGING) return;
  const root = 'ut1demo00000000000000000000000000000000';
  await pool.query(
    `INSERT INTO elections (eid, name, root_pubkey, creator_pubkey, tx_id, created_at)
     VALUES ('demo-election', 'Staging demo — General Election', $1, $1, 'demo-election', NOW())
     ON CONFLICT (eid) DO NOTHING`, [root]);
  await pool.query(
    `INSERT INTO watched_addresses (address, cursor, added_at) VALUES ($1, NULL, NOW())
     ON CONFLICT (address) DO NOTHING`, [root]);
  await pool.query(
    `INSERT INTO candidates (eid, cid, name, tx_id) VALUES
       ('demo-election', 1, 'Demo Candidate Red', 'demo-c1'),
       ('demo-election', 2, 'Demo Candidate Blue', 'demo-c2')
     ON CONFLICT (eid, cid) DO NOTHING`);
  await pool.query(
    `INSERT INTO stations (eid, sid, name, tx_id) VALUES
       ('demo-election', 1, 'Demo Station A', 'demo-s1'),
       ('demo-election', 2, 'Demo Station B', 'demo-s2'),
       ('demo-election', 3, 'Demo Station C', 'demo-s3')
     ON CONFLICT (eid, sid) DO NOTHING`);
  // Station A has TWO submissions (the later one wins). Station B has one.
  // Station C is unreported → "2 of 3 stations reported".
  await pool.query(
    `INSERT INTO results (tx_id, eid, sid, submitter_pubkey, votes, tot, inv, created_at) VALUES
       ('demo-r1', 'demo-election', 1, $1, '{"1":40,"2":60}'::jsonb, 105, 5, NOW() - INTERVAL '20 minutes'),
       ('demo-r2', 'demo-election', 1, $1, '{"1":52,"2":71}'::jsonb, 128, 5, NOW() - INTERVAL '2 minutes'),
       ('demo-r3', 'demo-election', 2, $1, '{"1":80,"2":35}'::jsonb, 120, 5, NOW() - INTERVAL '10 minutes')
     ON CONFLICT (tx_id) DO NOTHING`, [root]);
}

async function start() {
  await migrate();
  await seedStaging();
  // Continuous indexer: rebuild the read model from on-chain transactions.
  setInterval(() => pollOnce().catch((e) => console.error('pollOnce failed:', e.message)), 4000);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });

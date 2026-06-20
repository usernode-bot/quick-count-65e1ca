const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const txsource = require('./lib/txsource');
const { normalizeTx, applyTx } = require('./lib/indexer');
const { latestPerStation, computeTally, reporting } = require('./lib/aggregate');
const { isKind, validateImageUpload } = require('./lib/attach');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

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

// Public config (staging banner, poll hint). Public so the dashboard can read it.
app.get('/api/public/config', (_req, res) => {
  res.json({ staging: IS_STAGING });
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

// ── Off-chain image attachments ──────────────────────────────────────────────
// Candidate avatars and station C1-form scans. These are NON-CONSENSUS,
// off-chain data: not signed, not on-chain, never rebuilt by the indexer. They
// live in their own table keyed by the same logical ids the chain uses
// (eid + cid / eid + sid) so uploads don't depend on the election being indexed
// yet (production indexing lag; staging has no chain at all).

// Authenticated: upload (or replace) an attachment. Route-scoped JSON parser
// with a raised limit — the global express.json() caps bodies at 100 KB, which
// a 2 MB base64 image would blow past before reaching this handler.
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

    // Which candidates/stations have an off-chain image attachment.
    const att = (await pool.query('SELECT kind, ref_id FROM attachments WHERE eid = $1', [eid])).rows;
    const hasAvatar = new Set(att.filter((a) => a.kind === 'cand_avatar').map((a) => Number(a.ref_id)));
    const hasC1 = new Set(att.filter((a) => a.kind === 'station_c1').map((a) => Number(a.ref_id)));
    const avatarUrl = (cid) => `/api/public/elections/${encodeURIComponent(eid)}/attachments/cand_avatar/${cid}`;
    const c1Url = (sid) => `/api/public/elections/${encodeURIComponent(eid)}/attachments/station_c1/${sid}`;

    const candidates = (await pool.query('SELECT cid, name FROM candidates WHERE eid = $1 ORDER BY cid', [eid])).rows
      .map((c) => ({ cid: Number(c.cid), name: c.name, avatar: hasAvatar.has(Number(c.cid)) ? avatarUrl(Number(c.cid)) : null }));
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
        c1: hasC1.has(s.sid) ? c1Url(s.sid) : null,
      };
    });
    let lastUpdated = null;
    for (const r of results) if (r.created_at && (!lastUpdated || r.created_at > lastUpdated)) lastUpdated = r.created_at;

    res.json({
      election: { eid: el.eid, name: el.name, root_pubkey: el.root_pubkey },
      candidates,
      stations: perStation,
      tally,
      reporting: prog,
      lastUpdated,
    });
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

  // Obviously-fake demo image attachments so the new avatar/C1 UI is visible in
  // PR previews: solid red/blue 8×8 PNG avatars for the two demo candidates and
  // a gray placeholder "C1 scan" for Demo Station A.
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
}

async function start() {
  await migrate();
  await seedStaging();
  // Continuous indexer: rebuild the read model from on-chain transactions.
  setInterval(() => pollOnce().catch((e) => console.error('pollOnce failed:', e.message)), 4000);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });

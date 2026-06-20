const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { uploadToIPFS } = require('./lib/ipfs');
const { getBalance, getTransaction } = require('./lib/blockchain');
const { startIndexer, reindexAll, decodeMemo, indexTransaction } = require('./lib/indexer');

const txsource = require('./lib/txsource');
const { normalizeTx, applyTx } = require('./lib/indexer');
const { latestPerStation, computeTally, reporting } = require('./lib/aggregate');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const APP_PUBKEY = process.env.APP_PUBKEY || '';
const NODE_RPC_URL = process.env.NODE_RPC_URL || '';
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const IS_LOCAL_DEV = process.env.LOCAL_DEV === 'true';

// Paths that stay open without authentication.
const PUBLIC_API_PATHS = new Set(['/health', '/api/config']);
// Public path prefixes that bypass the JWT gate. `/explorer-api/*` is the
// platform's transparent explorer proxy. `/api/public/*` serves the public
// live dashboard, which logged-out visitors must be able to read.
const PUBLIC_PREFIXES = ['/explorer-api/', '/api/public/'];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Raw body for explorer-api proxy must come before json parser
app.use('/explorer-api', express.raw({ type: '*/*', limit: '2mb' }));
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

async function getUserRole(userId, username) {
  if (!userId) return 'observer';
  const adminRes = await pool.query("SELECT id FROM user_roles WHERE user_id = $1 AND role = 'admin'", [userId]);
  if (adminRes.rows.length > 0) return 'admin';
  const agentRes = await pool.query(
    'SELECT id FROM station_agents WHERE user_id = $1 OR (user_id = 0 AND username = $2) LIMIT 1',
    [userId, username || '']
  );
  if (agentRes.rows.length > 0) return 'agent';
  return 'observer';
}

async function requireAdmin(req, res, next) {
  try {
    const role = await getUserRole(req.user?.id, req.user?.username);
    if (role !== 'admin') return res.status(403).json({ error: 'Admin required' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

async function requireAgent(req, res, next) {
  try {
    const role = await getUserRole(req.user?.id, req.user?.username);
    if (role !== 'agent' && role !== 'admin') return res.status(403).json({ error: 'Agent role required' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// Explorer-api proxy (bridge uses this for tx broadcasting, publicly accessible)
app.use('/explorer-api', async (req, res) => {
  if (!NODE_RPC_URL) return res.status(503).json({ error: 'Node RPC not configured' });
  try {
    const qs = req.url.includes('?') ? '?' + req.url.split('?').slice(1).join('?') : '';
    const url = `${NODE_RPC_URL}${req.path}${qs}`;
    const opts = { method: req.method, headers: {} };
    if (req.body && Buffer.isBuffer(req.body) && req.body.length > 0) {
      opts.body = req.body;
      opts.headers['Content-Type'] = req.headers['content-type'] || 'application/json';
    }
    const upstream = await fetch(url, opts);
    const text = await upstream.text();
    res.status(upstream.status).set('Content-Type', upstream.headers.get('content-type') || 'application/json').send(text);
  } catch (err) { res.status(502).json({ error: 'Upstream error: ' + err.message }); }
});

// ── Read-model store (PgStore) used by the chain indexer ────────────────────
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

// ── Chain indexer poll loop ──────────────────────────────────────────────────
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

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/config', (_req, res) => res.json({ isStaging: IS_STAGING, appPubkey: APP_PUBKEY }));

// Public config (staging banner). Public so the dashboard can read it without auth.
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

// Public: list elections with counts (chain-indexed read model).
app.get('/api/public/elections', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.eid, e.name, e.created_at,
        (SELECT COUNT(*) FROM candidates c WHERE c.eid = e.eid) AS candidate_count,
        (SELECT COUNT(*) FROM stations s WHERE s.eid = e.eid) AS station_count,
        (SELECT COUNT(DISTINCT r.sid) FROM results r WHERE r.eid = e.eid) AS reported_count
      FROM elections e WHERE e.eid IS NOT NULL
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

// --- Elections (management API) ---
app.get('/api/elections', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT e.*, o.name AS organization_name
      FROM elections e JOIN organizations o ON o.id = e.organization_id
      ORDER BY (e.status = 'active') DESC, e.created_at DESC
    `);
    res.json({ elections: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/elections/:id/dashboard', async (req, res) => {
  try {
    const electionId = parseInt(req.params.id);
    const [elecRes, candidatesRes, regionsRes, stationsRes, subsRes] = await Promise.all([
      pool.query(`SELECT e.*, o.name AS organization_name FROM elections e JOIN organizations o ON o.id = e.organization_id WHERE e.id = $1`, [electionId]),
      pool.query('SELECT * FROM candidates WHERE election_id = $1 ORDER BY sort_order', [electionId]),
      pool.query('SELECT * FROM regions WHERE election_id = $1 ORDER BY name', [electionId]),
      pool.query('SELECT * FROM polling_stations WHERE election_id = $1 ORDER BY name', [electionId]),
      pool.query(`SELECT cs.*, ps.name AS station_name, ps.region_id FROM cached_submissions cs JOIN polling_stations ps ON ps.id = cs.station_id WHERE cs.election_id = $1 ORDER BY cs.chain_timestamp DESC`, [electionId]),
    ]);

    if (!elecRes.rows.length) return res.status(404).json({ error: 'Election not found' });
    const election = elecRes.rows[0];
    const candidates = candidatesRes.rows;
    const regions = regionsRes.rows;
    const stations = stationsRes.rows;
    const submissions = subsRes.rows;

    function aggregateVotes(subs) {
      const totals = {};
      let blank = 0, invalid = 0;
      candidates.forEach(c => { totals[c.id] = 0; });
      for (const sub of subs) {
        const votes = typeof sub.votes === 'string' ? JSON.parse(sub.votes) : (sub.votes || {});
        for (const [k, v] of Object.entries(votes)) {
          const val = parseInt(v) || 0;
          if (k === 'blank') blank += val;
          else if (k === 'invalid') invalid += val;
          else { const cid = parseInt(k); if (totals[cid] !== undefined) totals[cid] += val; }
        }
      }
      return { totals, blank, invalid };
    }

    const { totals, blank, invalid } = aggregateVotes(submissions);
    const totalValid = candidates.reduce((s, c) => s + (totals[c.id] || 0), 0);
    const reportedIds = new Set(submissions.map(s => s.station_id));

    const regionData = regions.map(r => {
      const rStations = stations.filter(s => s.region_id === r.id);
      const rSubs = submissions.filter(s => rStations.some(rs => rs.id === s.station_id));
      const { totals: rt, blank: rb, invalid: ri } = aggregateVotes(rSubs);
      const rValid = candidates.reduce((s, c) => s + (rt[c.id] || 0), 0);
      return {
        ...r,
        total_stations: rStations.length,
        reported_stations: rSubs.length,
        blank: rb, invalid: ri,
        candidates: candidates.map(c => ({ ...c, votes: rt[c.id] || 0, pct: rValid > 0 ? Math.round((rt[c.id] || 0) / rValid * 1000) / 10 : 0 })),
      };
    });

    const stationList = stations.map(s => {
      const sub = submissions.find(sb => sb.station_id === s.id);
      return { ...s, region_name: regions.find(r => r.id === s.region_id)?.name || '', reported: !!sub, tx_hash: sub?.tx_hash || null, chain_timestamp: sub?.chain_timestamp || null };
    });

    res.json({
      election,
      progress: { total: stations.length, reported: reportedIds.size, pct: stations.length > 0 ? Math.round(reportedIds.size / stations.length * 100) : 0 },
      candidates: candidates.map(c => ({ ...c, votes: totals[c.id] || 0, pct: totalValid > 0 ? Math.round((totals[c.id] || 0) / totalValid * 1000) / 10 : 0 })),
      blank, invalid, regions: regionData, stations: stationList,
      recent_submissions: submissions.slice(0, 20).map(s => ({ tx_hash: s.tx_hash, station_name: s.station_name, submitter_username: s.submitter_username, chain_timestamp: s.chain_timestamp, block_height: s.block_height })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/elections/:id/timeline', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cs.tx_hash, cs.chain_timestamp, cs.block_height, ps.name AS station_name, cs.submitter_username
      FROM cached_submissions cs JOIN polling_stations ps ON ps.id = cs.station_id
      WHERE cs.election_id = $1 ORDER BY cs.chain_timestamp ASC
    `, [parseInt(req.params.id)]);
    res.json({ timeline: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Explorer ---
app.get('/api/explorer/transactions', async (req, res) => {
  try {
    const { election_id, limit = 50, offset = 0 } = req.query;
    const params = [parseInt(limit), parseInt(offset)];
    let where = '1=1';
    if (election_id) { params.push(parseInt(election_id)); where = `cs.election_id = $${params.length}`; }
    const { rows } = await pool.query(`
      SELECT cs.tx_hash, cs.chain_timestamp, cs.block_height, cs.submitter_username, cs.cid, cs.votes,
             ps.name AS station_name, r.name AS region_name, e.name AS election_name, cs.election_id
      FROM cached_submissions cs
      JOIN polling_stations ps ON ps.id = cs.station_id
      LEFT JOIN regions r ON r.id = ps.region_id
      JOIN elections e ON e.id = cs.election_id
      WHERE ${where} ORDER BY cs.chain_timestamp DESC LIMIT $1 OFFSET $2
    `, params);
    res.json({ transactions: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/explorer/transactions/:txHash', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cs.*, ps.name AS station_name, r.name AS region_name, e.name AS election_name
      FROM cached_submissions cs
      JOIN polling_stations ps ON ps.id = cs.station_id
      LEFT JOIN regions r ON r.id = ps.region_id
      JOIN elections e ON e.id = cs.election_id
      WHERE cs.tx_hash = $1
    `, [req.params.txHash]);
    if (!rows.length) return res.status(404).json({ error: 'Transaction not found' });
    res.json({ transaction: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Agent endpoints ---
app.get('/api/my-assignment', requireAgent, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT sa.station_id, ps.name AS station_name, ps.election_id, ps.region_id,
             ps.latitude, ps.longitude, ps.code AS qr_code,
             e.name AS election_name, e.gps_required, e.gps_radius_meters, e.qr_required, e.status AS election_status,
             r.name AS region_name,
             cs.tx_hash AS submitted_tx_hash, cs.chain_timestamp AS submitted_at
      FROM station_agents sa
      JOIN polling_stations ps ON ps.id = sa.station_id
      JOIN elections e ON e.id = ps.election_id
      LEFT JOIN regions r ON r.id = ps.region_id
      LEFT JOIN cached_submissions cs ON cs.station_id = sa.station_id AND cs.election_id = ps.election_id
      WHERE sa.user_id = $1 OR (sa.user_id = 0 AND sa.username = $2)
    `, [req.user.id, req.user.username || '']);
    res.json({ assignments: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/balance', requireAgent, async (req, res) => {
  try {
    const pubkey = req.user.usernode_pubkey;
    if (!pubkey) return res.json({ balance: null, error: 'No wallet linked' });
    const balance = await getBalance(pubkey);
    res.json({ balance, pubkey });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/prepare-submission', upload.single('photo'), requireAgent, async (req, res) => {
  try {
    const { stationId, electionId, votes: votesStr, gps: gpsStr, qrCode } = req.body;
    const photo = req.file;
    if (!stationId || !electionId || !votesStr) return res.status(400).json({ error: 'stationId, electionId, and votes required' });
    if (!photo) return res.status(400).json({ error: 'Photo evidence is required' });

    let votes;
    try { votes = JSON.parse(votesStr); } catch { return res.status(400).json({ error: 'Invalid votes JSON' }); }
    for (const [k, v] of Object.entries(votes)) {
      const n = parseInt(v);
      if (isNaN(n) || n < 0) return res.status(400).json({ error: `Invalid vote count for ${k}` });
      votes[k] = n;
    }

    const sid = parseInt(stationId), eid = parseInt(electionId);

    const agentRes = await pool.query(
      'SELECT id FROM station_agents WHERE (user_id = $1 OR (user_id = 0 AND username = $3)) AND station_id = $2',
      [req.user.id, sid, req.user.username || '']
    );
    const isAdmin = (await pool.query("SELECT id FROM user_roles WHERE user_id = $1 AND role = 'admin'", [req.user.id])).rows.length > 0;
    if (!agentRes.rows.length && !isAdmin) return res.status(403).json({ error: 'Not assigned to this station' });

    const stationRes = await pool.query(
      `SELECT ps.*, e.gps_required, e.gps_radius_meters, e.qr_required, e.status AS election_status, e.organization_id
       FROM polling_stations ps JOIN elections e ON e.id = ps.election_id
       WHERE ps.id = $1 AND ps.election_id = $2`, [sid, eid]
    );
    if (!stationRes.rows.length) return res.status(404).json({ error: 'Station not found in this election' });
    const station = stationRes.rows[0];
    if (station.election_status !== 'active') return res.status(409).json({ error: 'Election is not active' });

    const existingRes = await pool.query('SELECT tx_hash FROM cached_submissions WHERE station_id = $1 AND election_id = $2', [sid, eid]);
    if (existingRes.rows.length > 0) return res.status(409).json({ error: 'Submission already exists for this station', tx_hash: existingRes.rows[0].tx_hash });

    if (station.gps_required && !IS_LOCAL_DEV) {
      let gps; try { gps = JSON.parse(gpsStr || 'null'); } catch {}
      if (!gps || typeof gps.lat !== 'number' || typeof gps.lng !== 'number') return res.status(400).json({ error: 'GPS coordinates required' });
      if (station.latitude && station.longitude) {
        const dist = haversineMeters(gps.lat, gps.lng, station.latitude, station.longitude);
        if (dist > (station.gps_radius_meters || 500)) return res.status(400).json({ error: `GPS too far from station (${Math.round(dist)}m)` });
      }
    }

    if (station.qr_required && station.code && !IS_LOCAL_DEV && (qrCode || '').trim() !== station.code.trim()) {
      return res.status(400).json({ error: 'QR code does not match' });
    }

    const pubkey = req.user.usernode_pubkey;
    if (!pubkey) return res.status(400).json({ error: 'No wallet linked to your account' });

    const balance = await getBalance(pubkey);
    if (balance !== null && balance < 11) {
      return res.status(400).json({ ok: false, reason: 'insufficient_balance', balance, required: 11 });
    }

    let cid;
    try { cid = await uploadToIPFS(photo.buffer, photo.originalname, photo.mimetype); }
    catch (err) { return res.status(500).json({ error: 'Photo upload failed: ' + err.message }); }

    const memo = JSON.stringify({
      app: 'quickcount',
      type: 'submit_result',
      organization_id: station.organization_id,
      election_id: eid,
      station_id: sid,
      agent: req.user.username,
      pubkey,
      votes,
      cid,
      timestamp: Math.floor(Date.now() / 1000),
    });

    res.json({ ok: true, memo, recipient: APP_PUBKEY, amount: 1, cid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/watch-submission', requireAgent, async (req, res) => {
  const { txHash } = req.body;
  if (!txHash) return res.status(400).json({ error: 'txHash required' });
  res.json({ ok: true, txHash });
});

app.get('/api/submission-status/:txHash', requireAgent, async (req, res) => {
  try {
    const { txHash } = req.params;
    const cached = await pool.query('SELECT * FROM cached_submissions WHERE tx_hash = $1', [txHash]);
    if (cached.rows.length > 0) {
      const sub = cached.rows[0];
      return res.json({ status: 'confirmed', blockHeight: sub.block_height, chainTimestamp: sub.chain_timestamp, txHash });
    }
    // In LOCAL_DEV, fake tx hashes are immediately confirmed without hitting the chain.
    if (IS_LOCAL_DEV && txHash.startsWith('local-dev-')) {
      return res.json({ status: 'confirmed', blockHeight: 9999, chainTimestamp: new Date().toISOString(), txHash });
    }

    const tx = await getTransaction(txHash);
    if (!tx || !tx.id) return res.json({ status: 'pending', txHash });
    const memo = decodeMemo(tx.attachment || tx.data || '');
    if (memo && memo.app === 'quickcount') {
      await indexTransaction(tx, pool);
      const rechecked = await pool.query('SELECT * FROM cached_submissions WHERE tx_hash = $1', [txHash]);
      if (rechecked.rows.length > 0) {
        const sub = rechecked.rows[0];
        return res.json({ status: 'confirmed', blockHeight: sub.block_height, chainTimestamp: sub.chain_timestamp, txHash });
      }
    }
    res.json({ status: 'pending', txHash });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- Admin endpoints ---
app.post('/api/admin/organizations', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query('INSERT INTO organizations (name) VALUES ($1) RETURNING *', [name]);
    res.json({ organization: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/elections', requireAdmin, async (req, res) => {
  try {
    const { organization_id, name, gps_required = false, gps_radius_meters = 500, qr_required = false, candidates = [] } = req.body;
    if (!organization_id || !name) return res.status(400).json({ error: 'organization_id and name required' });
    const { rows } = await pool.query(`
      INSERT INTO elections (organization_id, name, gps_required, gps_radius_meters, qr_required)
      VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [organization_id, name, gps_required, gps_radius_meters, qr_required]);
    const election = rows[0];
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i]?.name) await pool.query('INSERT INTO candidates (election_id, name, sort_order) VALUES ($1,$2,$3)', [election.id, candidates[i].name, i]);
    }
    res.json({ election });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/elections/:id/regions', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query('INSERT INTO regions (election_id, name) VALUES ($1,$2) RETURNING *', [parseInt(req.params.id), name]);
    res.json({ region: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/elections/:id/stations', requireAdmin, async (req, res) => {
  try {
    const { name, region_id, code, latitude, longitude, total_registered_voters } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await pool.query(`
      INSERT INTO polling_stations (election_id, region_id, name, code, latitude, longitude, total_registered_voters)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [parseInt(req.params.id), region_id || null, name, code || null, latitude || null, longitude || null, total_registered_voters || null]);
    res.json({ station: rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/elections/:id/agents', requireAdmin, async (req, res) => {
  try {
    const { username, station_id } = req.body;
    if (!username || !station_id) return res.status(400).json({ error: 'username and station_id required' });
    const { rows } = await pool.query(`
      INSERT INTO station_agents (station_id, user_id, username) VALUES ($1, 0, $2)
      ON CONFLICT DO NOTHING RETURNING *
    `, [parseInt(station_id), username]);
    res.json({ agent: rows[0] || { station_id, username } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/submissions/:txHash', requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM cached_submissions WHERE tx_hash = $1', [req.params.txHash]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reindex', requireAdmin, async (req, res) => {
  try { await reindexAll(pool); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT cs.tx_hash, cs.chain_timestamp, cs.block_height, cs.submitter_username,
             cs.submitter_pubkey, cs.cid, cs.votes, cs.indexed_at,
             ps.name AS station_name, e.name AS election_name, r.name AS region_name
      FROM cached_submissions cs
      JOIN polling_stations ps ON ps.id = cs.station_id
      JOIN elections e ON e.id = cs.election_id
      LEFT JOIN regions r ON r.id = ps.region_id
      ORDER BY cs.indexed_at DESC LIMIT 200
    `);
    res.json({ log: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/organizations', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM organizations ORDER BY name');
    res.json({ organizations: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

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
  // Organizations (used by the management UI)
  await pool.query(`CREATE TABLE IF NOT EXISTS organizations (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Elections: unified schema — HEAD routes use elections.id (integer PK);
  // chain indexer routes use elections.eid (TEXT UNIQUE). Both coexist.
  await pool.query(`CREATE TABLE IF NOT EXISTS elections (
    id SERIAL PRIMARY KEY,
    eid TEXT UNIQUE,
    organization_id INTEGER REFERENCES organizations(id),
    name TEXT NOT NULL,
    root_pubkey TEXT,
    creator_pubkey TEXT,
    tx_id TEXT,
    status VARCHAR(50) DEFAULT 'active',
    gps_required BOOLEAN DEFAULT false,
    gps_radius_meters INTEGER DEFAULT 500,
    qr_required BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Candidates: unified — HEAD uses (election_id INTEGER, sort_order);
  // chain indexer uses (eid TEXT, cid INTEGER) with a unique constraint.
  await pool.query(`CREATE TABLE IF NOT EXISTS candidates (
    id SERIAL PRIMARY KEY,
    eid TEXT,
    cid INTEGER,
    election_id INTEGER REFERENCES elections(id),
    name TEXT NOT NULL,
    tx_id TEXT,
    sort_order INTEGER DEFAULT 0
  )`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS candidates_eid_cid_idx ON candidates(eid, cid)`);

  // Regions (management UI)
  await pool.query(`CREATE TABLE IF NOT EXISTS regions (
    id SERIAL PRIMARY KEY,
    election_id INTEGER NOT NULL REFERENCES elections(id),
    name VARCHAR(255) NOT NULL
  )`);

  // Polling stations (management UI — distinct from chain-indexed "stations" table)
  await pool.query(`CREATE TABLE IF NOT EXISTS polling_stations (
    id SERIAL PRIMARY KEY,
    election_id INTEGER NOT NULL REFERENCES elections(id),
    region_id INTEGER REFERENCES regions(id),
    name VARCHAR(255) NOT NULL,
    code VARCHAR(100),
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    total_registered_voters INTEGER
  )`);

  // Stations (chain-indexed — distinct from polling_stations)
  await pool.query(`CREATE TABLE IF NOT EXISTS stations (
    eid TEXT NOT NULL,
    sid INTEGER NOT NULL,
    name TEXT NOT NULL,
    tx_id TEXT,
    PRIMARY KEY (eid, sid)
  )`);

  // Station agents (management UI)
  await pool.query(`CREATE TABLE IF NOT EXISTS station_agents (
    id SERIAL PRIMARY KEY,
    station_id INTEGER NOT NULL REFERENCES polling_stations(id),
    user_id INTEGER NOT NULL DEFAULT 0,
    username VARCHAR(255) NOT NULL DEFAULT ''
  )`);

  // User roles (management UI)
  await pool.query(`CREATE TABLE IF NOT EXISTS user_roles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE,
    username VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL
  )`);

  // Cached submissions (populated by legacy indexer via polling APP_PUBKEY)
  await pool.query(`CREATE TABLE IF NOT EXISTS cached_submissions (
    id SERIAL PRIMARY KEY,
    tx_hash VARCHAR(255) UNIQUE NOT NULL,
    station_id INTEGER NOT NULL REFERENCES polling_stations(id),
    election_id INTEGER NOT NULL REFERENCES elections(id),
    submitter_user_id INTEGER,
    submitter_username VARCHAR(255) NOT NULL DEFAULT '',
    submitter_pubkey VARCHAR(255) NOT NULL DEFAULT '',
    votes JSONB NOT NULL DEFAULT '{}',
    cid VARCHAR(255),
    block_height INTEGER,
    chain_timestamp TIMESTAMPTZ,
    indexed_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Results (populated by chain indexer via applyTx)
  await pool.query(`CREATE TABLE IF NOT EXISTS results (
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

  // Watched addresses (chain indexer — which addresses to poll)
  await pool.query(`CREATE TABLE IF NOT EXISTS watched_addresses (
    address TEXT PRIMARY KEY,
    cursor TEXT,
    added_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Indexer state (legacy indexer — tracks last polled block height)
  await pool.query(`CREATE TABLE IF NOT EXISTS indexer_state (
    id INTEGER PRIMARY KEY DEFAULT 1,
    last_indexed_block INTEGER DEFAULT 0,
    last_indexed_at TIMESTAMPTZ
  )`);

  // Apply staging:private comments
  await pool.query(`
    COMMENT ON TABLE organizations IS 'staging:private';
    COMMENT ON TABLE elections IS 'staging:private';
    COMMENT ON TABLE candidates IS 'staging:private';
    COMMENT ON TABLE regions IS 'staging:private';
    COMMENT ON TABLE polling_stations IS 'staging:private';
    COMMENT ON TABLE stations IS 'staging:private';
    COMMENT ON TABLE station_agents IS 'staging:private';
    COMMENT ON TABLE user_roles IS 'staging:private';
    COMMENT ON TABLE cached_submissions IS 'staging:private';
    COMMENT ON TABLE results IS 'staging:private';
    COMMENT ON TABLE watched_addresses IS 'staging:private';
    COMMENT ON TABLE indexer_state IS 'staging:private';
  `);

  await pool.query(`ALTER TABLE station_agents ADD COLUMN IF NOT EXISTS username VARCHAR(255) NOT NULL DEFAULT ''`);

  if (IS_STAGING) {
    // Seed data for the management UI tables
    await pool.query(`INSERT INTO organizations (id, name) VALUES (1,'Staging Demo Electoral Commission') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO elections (id,organization_id,name,status,gps_required,qr_required) VALUES (1,1,'Staging Demo General Election 2026','active',false,false) ON CONFLICT (id) DO NOTHING`);
    await pool.query(`
      INSERT INTO candidates (id,election_id,name,sort_order) VALUES
        (1,1,'Staging Demo Candidate Alpha',1),
        (2,1,'Staging Demo Candidate Beta',2),
        (3,1,'Staging Demo Candidate Gamma',3)
      ON CONFLICT (id) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO regions (id,election_id,name) VALUES
        (1,1,'Staging Demo Northern Region'),
        (2,1,'Staging Demo Southern Region')
      ON CONFLICT (id) DO NOTHING
    `);
    const mgmtStations = [
      [1,1,1,'Staging Demo Station N-1','QR-N1',40.7128,-74.0060],
      [2,1,1,'Staging Demo Station N-2','QR-N2',40.7148,-74.0080],
      [3,1,1,'Staging Demo Station N-3','QR-N3',40.7108,-74.0040],
      [4,1,1,'Staging Demo Station N-4','QR-N4',40.7168,-74.0100],
      [5,1,1,'Staging Demo Station N-5','QR-N5',40.7088,-74.0020],
      [6,1,2,'Staging Demo Station S-1','QR-S1',40.6928,-74.0160],
      [7,1,2,'Staging Demo Station S-2','QR-S2',40.6948,-74.0180],
      [8,1,2,'Staging Demo Station S-3','QR-S3',40.6908,-74.0140],
      [9,1,2,'Staging Demo Station S-4','QR-S4',40.6968,-74.0200],
      [10,1,2,'Staging Demo Station S-5','QR-S5',40.6888,-74.0120],
    ];
    for (const [id,eid,rid,name,code,lat,lng] of mgmtStations) {
      await pool.query(`INSERT INTO polling_stations (id,election_id,region_id,name,code,latitude,longitude) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`, [id,eid,rid,name,code,lat,lng]);
    }
    await pool.query(`INSERT INTO user_roles (id,user_id,username,role) VALUES (1,1,'staging-demo-user','admin') ON CONFLICT (id) DO NOTHING`);
    await pool.query(`INSERT INTO station_agents (id,station_id,user_id,username) VALUES (1,1,1,'staging-demo-user') ON CONFLICT (id) DO NOTHING`);
    const now = Date.now();
    const subs = [
      [2,'aabbcc0000000000000000000000000000000000000000000000000000000002','{"1":148,"2":89,"3":41,"blank":5,"invalid":3}',now-22*3600000,1002],
      [3,'aabbcc0000000000000000000000000000000000000000000000000000000003','{"1":155,"2":93,"3":44,"blank":4,"invalid":2}',now-18*3600000,1012],
      [4,'aabbcc0000000000000000000000000000000000000000000000000000000004','{"1":142,"2":86,"3":38,"blank":6,"invalid":4}',now-15*3600000,1022],
      [6,'aabbcc0000000000000000000000000000000000000000000000000000000006','{"1":161,"2":97,"3":48,"blank":3,"invalid":2}',now-10*3600000,1032],
      [7,'aabbcc0000000000000000000000000000000000000000000000000000000007','{"1":137,"2":82,"3":35,"blank":7,"invalid":3}',now-6*3600000,1045],
      [8,'aabbcc0000000000000000000000000000000000000000000000000000000008','{"1":150,"2":91,"3":42,"blank":5,"invalid":3}',now-2*3600000,1058],
    ];
    for (const [stId,txHash,votes,ts,height] of subs) {
      await pool.query(`
        INSERT INTO cached_submissions (station_id,election_id,submitter_username,submitter_pubkey,votes,cid,block_height,chain_timestamp,tx_hash)
        VALUES ($1,1,'staging-demo-user','staging-demo-pubkey',$2,'QmPZ9gcCEpqKTo6aq61g2nXGUhM4iCL3ewB6LDXZCtioEB',$3,$4,$5)
        ON CONFLICT (tx_hash) DO NOTHING
      `, [stId, votes, height, new Date(ts), txHash]);
    }
    await pool.query(`INSERT INTO indexer_state (id,last_indexed_block) VALUES (1,1060) ON CONFLICT (id) DO UPDATE SET last_indexed_block=1060`);
  }

  startIndexer(pool);
}

// Staging-only demo data for the chain-indexed read model (main).
// Writes directly into elections/candidates/stations/results so the public
// dashboard isn't empty in PR previews. Strict no-op outside staging.
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
  // Continuous chain indexer: rebuild the read model from on-chain transactions.
  setInterval(() => pollOnce().catch((e) => console.error('pollOnce failed:', e.message)), 4000);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });

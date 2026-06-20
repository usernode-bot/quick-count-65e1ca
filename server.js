const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');
const { savePhoto, getPhotoPath, ensureUploadsDir } = require('./lib/storage');
const { getBalance, getTransaction, broadcastTransaction } = require('./lib/blockchain');
const { startIndexer, reindexAll, decodeMemo, indexTransaction } = require('./lib/indexer');

const txsource = require('./lib/txsource');
const { normalizeTx, applyTx } = require('./lib/indexer');
const { latestPerStation, computeTally, reporting } = require('./lib/aggregate');

const app = express();
const port = process.env.PORT || 3000;
const prisma = new PrismaClient();
const JWT_SECRET = process.env.JWT_SECRET;
const APP_PUBKEY = process.env.APP_PUBKEY || '';
const NODE_RPC_URL = process.env.NODE_RPC_URL || '';
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const IS_LOCAL_DEV = process.env.LOCAL_DEV === 'true';

const PUBLIC_API_PATHS = new Set(['/health', '/api/config']);
const PUBLIC_PREFIXES = ['/explorer-api/', '/api/public/'];

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

app.use('/explorer-api', express.raw({ type: '*/*', limit: '2mb' }));
app.use(express.json());

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
  const admin = await prisma.userRole.findFirst({
    where: { userId, role: 'admin' }
  });
  if (admin) return 'admin';
  const agent = await prisma.stationAgent.findFirst({
    where: {
      OR: [
        { userId },
        { userId: 0, username: username || '' }
      ]
    }
  });
  if (agent) return 'agent';
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

const store = {
  async getElection(eid) {
    const res = await prisma.$queryRaw`SELECT eid, name, root_pubkey, creator_pubkey FROM stations WHERE eid = ${eid} LIMIT 1`;
    return res[0] || null;
  },
  async putElection(r) {
    await prisma.$executeRaw`INSERT INTO elections (eid, name, root_pubkey, creator_pubkey, tx_id, created_at)
      VALUES (${r.eid}, ${r.name}, ${r.root_pubkey}, ${r.creator_pubkey}, ${r.tx_id}, ${r.created_at})
      ON CONFLICT (eid) DO NOTHING`;
  },
  async putCandidate(r) {
    await prisma.$executeRaw`INSERT INTO candidates (eid, cid, name, tx_id)
      VALUES (${r.eid}, ${r.cid}, ${r.name}, ${r.tx_id})
      ON CONFLICT (eid, cid) DO NOTHING`;
  },
  async putStation(r) {
    await prisma.$executeRaw`INSERT INTO stations (eid, sid, name, tx_id)
      VALUES (${r.eid}, ${r.sid}, ${r.name}, ${r.tx_id})
      ON CONFLICT (eid, sid) DO NOTHING`;
  },
  async putResult(r) {
    await prisma.$executeRaw`INSERT INTO results (tx_id, eid, sid, submitter_pubkey, votes, tot, inv, created_at)
      VALUES (${r.tx_id}, ${r.eid}, ${r.sid}, ${r.submitter_pubkey}, ${JSON.stringify(r.votes || {})}, ${r.tot}, ${r.inv}, ${r.created_at})
      ON CONFLICT (tx_id) DO NOTHING`;
  },
};

async function pollOnce() {
  const ws = await prisma.watchedAddress.findMany();
  for (const w of ws) {
    let txs = [];
    try {
      txs = await txsource.listTransactions({ account: w.address, sinceCursor: w.cursor });
    } catch { continue; }
    if (!Array.isArray(txs) || !txs.length) continue;
    const norm = txs.map(normalizeTx).filter((t) => t.txId);
    norm.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    let cursor = w.cursor;
    for (const t of norm) {
      try { await applyTx(store, t); } catch (e) { console.error('applyTx failed:', e.message); }
      if (t.createdAt && (!cursor || t.createdAt > cursor)) cursor = t.createdAt;
    }
    if (cursor && cursor !== w.cursor) {
      await prisma.watchedAddress.update({
        where: { address: w.address },
        data: { cursor }
      });
    }
  }
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.get('/api/config', (_req, res) => res.json({ isStaging: IS_STAGING, appPubkey: APP_PUBKEY }));

app.get('/api/public/config', (_req, res) => {
  res.json({ staging: IS_STAGING });
});

app.get('/api/me', (req, res) => {
  res.json({ username: req.user.username, usernode_pubkey: req.user.usernode_pubkey || null, staging: IS_STAGING });
});

app.post('/api/elections/track', async (req, res) => {
  try {
    const { root_pubkey, tx_id } = req.body || {};
    if (!root_pubkey) return res.status(400).json({ error: 'root_pubkey required' });
    if (req.user.usernode_pubkey && req.user.usernode_pubkey !== root_pubkey) {
      return res.status(403).json({ error: 'root_pubkey does not match your linked wallet' });
    }
    await prisma.watchedAddress.upsert({
      where: { address: root_pubkey },
      update: {},
      create: { address: root_pubkey }
    });
    pollOnce().catch(() => {});
    res.json({ ok: true, tx_id: tx_id || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/elections', async (_req, res) => {
  try {
    const elections = await prisma.election.findMany({
      orderBy: [{ createdAt: 'desc' }],
      include: {
        _count: {
          select: { candidates: true, pollingStations: true }
        }
      }
    });
    const data = await Promise.all(elections.map(async (e) => {
      const reportedCount = await prisma.cachedSubmission.findMany({
        where: { electionId: e.id },
        distinct: ['stationId']
      });
      return {
        eid: e.id,
        name: e.name,
        candidate_count: e._count.candidates,
        station_count: e._count.pollingStations,
        reported_count: reportedCount.length
      };
    }));
    res.json({ elections: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/elections/:eid', async (req, res) => {
  try {
    const eid = parseInt(req.params.eid);
    const el = await prisma.election.findUnique({
      where: { id: eid },
      include: { candidates: { orderBy: { sortOrder: 'asc' } }, pollingStations: true }
    });
    if (!el) return res.status(404).json({ error: 'not found' });

    const candidates = el.candidates.map((c) => ({ cid: c.id, name: c.name }));
    const stations = el.pollingStations.map((s) => ({ sid: s.id, name: s.name }));
    const results = await prisma.cachedSubmission.findMany({
      where: { electionId: eid }
    });

    const resultsData = results.map((r) => ({
      sid: r.stationId,
      tx_id: r.txHash,
      submitter_pubkey: r.submitterPubkey,
      votes: r.votes ? JSON.parse(r.votes) : {},
      tot: null,
      inv: null,
      created_at: r.chainTimestamp
    }));

    const latest = latestPerStation(resultsData);
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
    for (const r of resultsData) if (r.created_at && (!lastUpdated || r.created_at > lastUpdated)) lastUpdated = r.created_at;

    res.json({
      election: { eid: el.id, name: el.name },
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

app.get('/api/elections', async (req, res) => {
  try {
    const elections = await prisma.election.findMany({
      include: { organization: true },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }]
    });
    res.json({ elections });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/elections/:id/dashboard', async (req, res) => {
  try {
    const electionId = parseInt(req.params.id);
    const election = await prisma.election.findUnique({
      where: { id: electionId },
      include: { organization: true, candidates: true, regions: true, pollingStations: true }
    });

    if (!election) return res.status(404).json({ error: 'Election not found' });

    const submissions = await prisma.cachedSubmission.findMany({
      where: { electionId },
      include: { station: true }
    });

    function aggregateVotes(subs) {
      const totals = {};
      let blank = 0, invalid = 0;
      election.candidates.forEach(c => { totals[c.id] = 0; });
      for (const sub of subs) {
        const votes = sub.votes ? JSON.parse(sub.votes) : {};
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
    const totalValid = election.candidates.reduce((s, c) => s + (totals[c.id] || 0), 0);
    const reportedIds = new Set(submissions.map(s => s.stationId));

    const regionData = election.regions.map(r => {
      const rStations = election.pollingStations.filter(s => s.regionId === r.id);
      const rSubs = submissions.filter(s => rStations.some(rs => rs.id === s.stationId));
      const { totals: rt, blank: rb, invalid: ri } = aggregateVotes(rSubs);
      const rValid = election.candidates.reduce((s, c) => s + (rt[c.id] || 0), 0);
      return {
        ...r,
        total_stations: rStations.length,
        reported_stations: rSubs.length,
        blank: rb, invalid: ri,
        candidates: election.candidates.map(c => ({ ...c, votes: rt[c.id] || 0, pct: rValid > 0 ? Math.round((rt[c.id] || 0) / rValid * 1000) / 10 : 0 })),
      };
    });

    const stationList = election.pollingStations.map(s => {
      const sub = submissions.find(sb => sb.stationId === s.id);
      const regionName = election.regions.find(r => r.id === s.regionId)?.name || '';
      return { ...s, region_name: regionName, reported: !!sub, tx_hash: sub?.txHash || null, chain_timestamp: sub?.chainTimestamp || null };
    });

    res.json({
      election,
      progress: { total: election.pollingStations.length, reported: reportedIds.size, pct: election.pollingStations.length > 0 ? Math.round(reportedIds.size / election.pollingStations.length * 100) : 0 },
      candidates: election.candidates.map(c => ({ ...c, votes: totals[c.id] || 0, pct: totalValid > 0 ? Math.round((totals[c.id] || 0) / totalValid * 1000) / 10 : 0 })),
      blank, invalid, regions: regionData, stations: stationList,
      recent_submissions: submissions.slice(0, 20).map(s => ({ tx_hash: s.txHash, station_name: s.station.name, submitter_username: s.submitterUsername, chain_timestamp: s.chainTimestamp, block_height: s.blockHeight })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/elections/:id/timeline', async (req, res) => {
  try {
    const submissions = await prisma.cachedSubmission.findMany({
      where: { electionId: parseInt(req.params.id) },
      include: { station: true },
      orderBy: { chainTimestamp: 'asc' }
    });
    const timeline = submissions.map(s => ({
      tx_hash: s.txHash,
      chain_timestamp: s.chainTimestamp,
      block_height: s.blockHeight,
      station_name: s.station.name,
      submitter_username: s.submitterUsername
    }));
    res.json({ timeline });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/explorer/transactions', async (req, res) => {
  try {
    const { election_id, limit = 50, offset = 0 } = req.query;
    const where = election_id ? { electionId: parseInt(election_id) } : {};
    const rows = await prisma.cachedSubmission.findMany({
      where,
      include: { station: { include: { region: true } }, election: true },
      orderBy: { chainTimestamp: 'desc' },
      take: parseInt(limit),
      skip: parseInt(offset)
    });
    const transactions = rows.map(r => ({
      tx_hash: r.txHash,
      chain_timestamp: r.chainTimestamp,
      block_height: r.blockHeight,
      submitter_username: r.submitterUsername,
      photo_filename: r.photoFilename,
      votes: r.votes,
      station_name: r.station.name,
      region_name: r.station.region?.name || null,
      election_name: r.election.name,
      election_id: r.electionId
    }));
    res.json({ transactions });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/explorer/transactions/:txHash', async (req, res) => {
  try {
    const row = await prisma.cachedSubmission.findUnique({
      where: { txHash: req.params.txHash },
      include: { station: { include: { region: true } }, election: true }
    });
    if (!row) return res.status(404).json({ error: 'Transaction not found' });
    const transaction = {
      tx_hash: row.txHash,
      block_height: row.blockHeight,
      chain_timestamp: row.chainTimestamp,
      submitter_username: row.submitterUsername,
      submitter_pubkey: row.submitterPubkey,
      photo_filename: row.photoFilename,
      votes: row.votes,
      station_name: row.station.name,
      region_name: row.station.region?.name || null,
      election_name: row.election.name,
      indexed_at: row.indexedAt
    };
    res.json({ transaction });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/my-assignment', requireAgent, async (req, res) => {
  try {
    const assignments = await prisma.stationAgent.findMany({
      where: {
        OR: [
          { userId: req.user.id },
          { userId: 0, username: req.user.username || '' }
        ]
      },
      include: {
        station: {
          include: {
            election: true,
            region: true,
            cachedSubmissions: {
              where: { submitterUsername: req.user.username }
            }
          }
        }
      }
    });
    const data = assignments.map(a => ({
      station_id: a.station.id,
      station_name: a.station.name,
      election_id: a.station.electionId,
      region_id: a.station.regionId,
      latitude: a.station.latitude,
      longitude: a.station.longitude,
      qr_code: a.station.code,
      election_name: a.station.election.name,
      gps_required: a.station.election.gpsRequired,
      gps_radius_meters: a.station.election.gpsRadiusMeters,
      qr_required: a.station.election.qrRequired,
      election_status: a.station.election.status,
      region_name: a.station.region?.name || null,
      submitted_tx_hash: a.station.cachedSubmissions[0]?.txHash || null,
      submitted_at: a.station.cachedSubmissions[0]?.chainTimestamp || null
    }));
    res.json({ assignments: data });
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

    const agent = await prisma.stationAgent.findFirst({
      where: {
        stationId: sid,
        OR: [
          { userId: req.user.id },
          { userId: 0, username: req.user.username || '' }
        ]
      }
    });
    const isAdmin = await prisma.userRole.findFirst({
      where: { userId: req.user.id, role: 'admin' }
    });
    if (!agent && !isAdmin) return res.status(403).json({ error: 'Not assigned to this station' });

    const station = await prisma.pollingStation.findFirst({
      where: { id: sid, electionId: eid },
      include: { election: true }
    });
    if (!station) return res.status(404).json({ error: 'Station not found in this election' });
    if (station.election.status !== 'active') return res.status(409).json({ error: 'Election is not active' });

    const existing = await prisma.cachedSubmission.findFirst({
      where: { stationId: sid, electionId: eid }
    });
    if (existing) return res.status(409).json({ error: 'Submission already exists for this station', tx_hash: existing.txHash });

    if (station.election.gpsRequired && !IS_LOCAL_DEV) {
      let gps; try { gps = JSON.parse(gpsStr || 'null'); } catch {}
      if (!gps || typeof gps.lat !== 'number' || typeof gps.lng !== 'number') return res.status(400).json({ error: 'GPS coordinates required' });
      if (station.latitude && station.longitude) {
        const dist = haversineMeters(gps.lat, gps.lng, station.latitude, station.longitude);
        if (dist > (station.election.gpsRadiusMeters || 500)) return res.status(400).json({ error: `GPS too far from station (${Math.round(dist)}m)` });
      }
    }

    if (station.election.qrRequired && station.code && !IS_LOCAL_DEV && (qrCode || '').trim() !== station.code.trim()) {
      return res.status(400).json({ error: 'QR code does not match' });
    }

    const pubkey = req.user.usernode_pubkey;
    if (!pubkey) return res.status(400).json({ error: 'No wallet linked to your account' });

    const balance = await getBalance(pubkey);
    if (balance !== null && balance < 11) {
      return res.status(400).json({ ok: false, reason: 'insufficient_balance', balance, required: 11 });
    }

    const photoFilename = await savePhoto(photo.buffer, photo.originalname);

    const memo = JSON.stringify({
      app: 'quickcount',
      type: 'submit_result',
      organization_id: station.election.organizationId,
      election_id: eid,
      station_id: sid,
      agent: req.user.username,
      pubkey,
      votes,
      photo_filename: photoFilename,
      timestamp: Math.floor(Date.now() / 1000),
    });

    res.json({ ok: true, memo, recipient: APP_PUBKEY, amount: 1, photo_filename: photoFilename });
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
    const cached = await prisma.cachedSubmission.findUnique({
      where: { txHash }
    });
    if (cached) {
      return res.json({ status: 'confirmed', blockHeight: cached.blockHeight, chainTimestamp: cached.chainTimestamp, txHash });
    }

    if (IS_LOCAL_DEV && txHash.startsWith('local-dev-')) {
      return res.json({ status: 'confirmed', blockHeight: 9999, chainTimestamp: new Date().toISOString(), txHash });
    }

    const tx = await getTransaction(txHash);
    if (!tx || !tx.id) return res.json({ status: 'pending', txHash });
    const memo = decodeMemo(tx.attachment || tx.data || '');
    if (memo && memo.app === 'quickcount') {
      await indexTransaction(tx, prisma);
      const rechecked = await prisma.cachedSubmission.findUnique({
        where: { txHash }
      });
      if (rechecked) {
        return res.json({ status: 'confirmed', blockHeight: rechecked.blockHeight, chainTimestamp: rechecked.chainTimestamp, txHash });
      }
    }
    res.json({ status: 'pending', txHash });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/organizations', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const organization = await prisma.organization.create({
      data: { name }
    });
    res.json({ organization });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/elections', requireAdmin, async (req, res) => {
  try {
    const { organization_id, name, gps_required = false, gps_radius_meters = 500, qr_required = false, candidates = [] } = req.body;
    if (!organization_id || !name) return res.status(400).json({ error: 'organization_id and name required' });
    const election = await prisma.election.create({
      data: {
        organizationId: organization_id,
        name,
        gpsRequired: gps_required,
        gpsRadiusMeters: gps_radius_meters,
        qrRequired: qr_required
      }
    });
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i]?.name) {
        await prisma.candidate.create({
          data: { electionId: election.id, name: candidates[i].name, sortOrder: i }
        });
      }
    }
    res.json({ election });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/elections/:id/regions', requireAdmin, async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const region = await prisma.region.create({
      data: { electionId: parseInt(req.params.id), name }
    });
    res.json({ region });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/elections/:id/stations', requireAdmin, async (req, res) => {
  try {
    const { name, region_id, code, latitude, longitude, total_registered_voters } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const station = await prisma.pollingStation.create({
      data: {
        electionId: parseInt(req.params.id),
        regionId: region_id || null,
        name,
        code: code || null,
        latitude: latitude || null,
        longitude: longitude || null,
        totalRegisteredVoters: total_registered_voters || null
      }
    });
    res.json({ station });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/elections/:id/agents', requireAdmin, async (req, res) => {
  try {
    const { username, station_id } = req.body;
    if (!username || !station_id) return res.status(400).json({ error: 'username and station_id required' });
    const agent = await prisma.stationAgent.upsert({
      where: {
        id: 0 // Dummy, will use create on no match
      },
      update: {},
      create: { stationId: parseInt(station_id), userId: 0, username }
    });
    res.json({ agent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/submissions/:txHash', requireAdmin, async (req, res) => {
  try {
    await prisma.cachedSubmission.delete({
      where: { txHash: req.params.txHash }
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reindex', requireAdmin, async (req, res) => {
  try {
    await reindexAll(prisma);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/audit-log', requireAdmin, async (req, res) => {
  try {
    const log = await prisma.cachedSubmission.findMany({
      include: { station: { include: { region: true } }, election: true },
      orderBy: { indexedAt: 'desc' },
      take: 200
    });
    res.json({ log });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/organizations', requireAdmin, async (req, res) => {
  try {
    const organizations = await prisma.organization.findMany({
      orderBy: { name: 'asc' }
    });
    res.json({ organizations });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000, dLat = (lat2 - lat1) * Math.PI / 180, dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.use(express.static(path.join(__dirname, 'public')));

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
  const isStaging = IS_STAGING;

  if (isStaging) {
    await prisma.organization.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, name: 'Staging Demo Electoral Commission' }
    });

    const election = await prisma.election.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        organizationId: 1,
        name: 'Staging Demo General Election 2026',
        status: 'active',
        gpsRequired: false,
        qrRequired: false
      }
    });

    await prisma.candidate.deleteMany({ where: { electionId: 1 } });
    await prisma.candidate.createMany({
      data: [
        { electionId: 1, name: 'Staging Demo Candidate Alpha', sortOrder: 1 },
        { electionId: 1, name: 'Staging Demo Candidate Beta', sortOrder: 2 },
        { electionId: 1, name: 'Staging Demo Candidate Gamma', sortOrder: 3 }
      ]
    });

    await prisma.region.deleteMany({ where: { electionId: 1 } });
    const regions = await prisma.region.createMany({
      data: [
        { electionId: 1, name: 'Staging Demo Northern Region' },
        { electionId: 1, name: 'Staging Demo Southern Region' }
      ]
    });

    await prisma.pollingStation.deleteMany({ where: { electionId: 1 } });
    const stations = [
      [1, 1, 'Staging Demo Station N-1', 'QR-N1', 40.7128, -74.0060],
      [2, 1, 'Staging Demo Station N-2', 'QR-N2', 40.7148, -74.0080],
      [3, 1, 'Staging Demo Station N-3', 'QR-N3', 40.7108, -74.0040],
      [4, 1, 'Staging Demo Station N-4', 'QR-N4', 40.7168, -74.0100],
      [5, 1, 'Staging Demo Station N-5', 'QR-N5', 40.7088, -74.0020],
      [6, 2, 'Staging Demo Station S-1', 'QR-S1', 40.6928, -74.0160],
      [7, 2, 'Staging Demo Station S-2', 'QR-S2', 40.6948, -74.0180],
      [8, 2, 'Staging Demo Station S-3', 'QR-S3', 40.6908, -74.0140],
      [9, 2, 'Staging Demo Station S-4', 'QR-S4', 40.6968, -74.0200],
      [10, 2, 'Staging Demo Station S-5', 'QR-S5', 40.6888, -74.0120],
    ];
    for (const [id, rid, name, code, lat, lng] of stations) {
      await prisma.pollingStation.upsert({
        where: { id },
        update: {},
        create: { id, electionId: 1, regionId: rid, name, code, latitude: lat, longitude: lng }
      });
    }

    await prisma.userRole.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, userId: 1, username: 'staging-demo-user', role: 'admin' }
    });

    await prisma.stationAgent.upsert({
      where: { id: 1 },
      update: {},
      create: { id: 1, stationId: 1, userId: 1, username: 'staging-demo-user' }
    });

    const now = Date.now();
    const subs = [
      [2, 'aabbcc0000000000000000000000000000000000000000000000000000000002', '{"1":148,"2":89,"3":41,"blank":5,"invalid":3}', now-22*3600000, 1002],
      [3, 'aabbcc0000000000000000000000000000000000000000000000000000000003', '{"1":155,"2":93,"3":44,"blank":4,"invalid":2}', now-18*3600000, 1012],
      [4, 'aabbcc0000000000000000000000000000000000000000000000000000000004', '{"1":142,"2":86,"3":38,"blank":6,"invalid":4}', now-15*3600000, 1022],
      [6, 'aabbcc0000000000000000000000000000000000000000000000000000000006', '{"1":161,"2":97,"3":48,"blank":3,"invalid":2}', now-10*3600000, 1032],
      [7, 'aabbcc0000000000000000000000000000000000000000000000000000000007', '{"1":137,"2":82,"3":35,"blank":7,"invalid":3}', now-6*3600000, 1045],
      [8, 'aabbcc0000000000000000000000000000000000000000000000000000000008', '{"1":150,"2":91,"3":42,"blank":5,"invalid":3}', now-2*3600000, 1058],
    ];
    for (const [stId, txHash, votes, ts, height] of subs) {
      await prisma.cachedSubmission.upsert({
        where: { txHash },
        update: {},
        create: {
          txHash,
          stationId: stId,
          electionId: 1,
          submitterUsername: 'staging-demo-user',
          submitterPubkey: 'staging-demo-pubkey',
          votes,
          photoFilename: null,
          blockHeight: height,
          chainTimestamp: new Date(ts)
        }
      });
    }

    await prisma.indexerState.upsert({
      where: { id: 1 },
      update: { lastIndexedBlock: 1060 },
      create: { id: 1, lastIndexedBlock: 1060 }
    });
  }

  startIndexer(prisma);
}

async function start() {
  try {
    ensureUploadsDir();
    await migrate();
    setInterval(() => pollOnce().catch((e) => console.error('pollOnce failed:', e.message)), 4000);
    app.listen(port, () => console.log(`Listening on :${port}`));
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start().catch(err => {
  console.error(err);
  process.exit(1);
});

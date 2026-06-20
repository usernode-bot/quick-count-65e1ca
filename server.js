const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { PrismaClient } = require('@prisma/client');

const { normalizeTx, applyTx, pollOnce } = require('./lib/indexer');
const { latestPerStation, computeTally, reporting } = require('./lib/aggregate');
const blockchain = require('./lib/blockchain');
const storage = require('./lib/storage');
const { resultMemo } = require('./lib/memo');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const prisma = new PrismaClient();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Auth & role middleware ───────────────────────────────────────────────────

const PUBLIC_API_PATHS = new Set(['/health']);
const PUBLIC_PREFIXES = ['/explorer-api/', '/api/public/'];
const ROLE_LEVELS = { observer: 0, agent: 1, admin: 2 };

async function resolveRole(userId) {
  const [ur, sa] = await Promise.all([
    prisma.userRole.findUnique({ where: { userId } }),
    prisma.stationAgent.findFirst({ where: { userId } }),
  ]);
  if (ur && ur.role === 'admin') return 'admin';
  if (sa) return 'agent';
  if (ur && ur.role === 'agent') return 'agent';
  return 'observer';
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if ((ROLE_LEVELS[req.role] || 0) < ROLE_LEVELS[minRole]) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

app.use(express.json());
app.use(async (req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }
  req.role = req.user ? await resolveRole(req.user.id) : 'observer';
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ── Static files ─────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Public API (for dashboard.html) ─────────────────────────────────────────

app.get('/api/public/config', (_req, res) => {
  res.json({ staging: IS_STAGING });
});

app.get('/api/public/elections', async (_req, res) => {
  try {
    const elections = await prisma.election.findMany({
      include: {
        _count: { select: { candidates: true, stations: true } },
        submissions: { select: { stationId: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      elections: elections.map((e) => ({
        eid: String(e.id),
        id: e.id,
        name: e.name,
        candidate_count: e._count.candidates,
        station_count: e._count.stations,
        reported_count: new Set(e.submissions.map((s) => s.stationId)).size,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/elections/:eid', async (req, res) => {
  try {
    const elId = parseInt(req.params.eid);
    if (isNaN(elId)) return res.status(404).json({ error: 'not found' });
    const el = await prisma.election.findUnique({
      where: { id: elId },
      include: {
        candidates: { orderBy: { sortOrder: 'asc' } },
        stations: { include: { region: true }, orderBy: { id: 'asc' } },
        submissions: true,
      },
    });
    if (!el) return res.status(404).json({ error: 'not found' });

    const candidates = el.candidates.map((c) => ({ cid: c.id, name: c.name }));
    const stations = el.stations.map((s) => ({ sid: s.id, name: s.name }));
    const results = el.submissions.map((s) => ({
      sid: s.stationId,
      tx_id: s.txHash,
      votes: s.votes || {},
      tot: null,
      inv: null,
      created_at: s.chainTimestamp ? s.chainTimestamp.toISOString() : s.indexedAt.toISOString(),
      submitter_pubkey: s.submitterPubkey,
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
        tot: null,
        inv: null,
        at: r ? r.created_at : null,
        submitter: r ? r.submitter_pubkey : null,
      };
    });
    let lastUpdated = null;
    for (const r of results) {
      if (r.created_at && (!lastUpdated || r.created_at > lastUpdated)) lastUpdated = r.created_at;
    }

    res.json({
      election: { eid: String(el.id), id: el.id, name: el.name, root_pubkey: null },
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

// ── Authenticated API ────────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
  res.json({
    id: req.user.id,
    username: req.user.username,
    usernode_pubkey: req.user.usernode_pubkey || null,
    role: req.role,
    staging: IS_STAGING,
  });
});

app.get('/api/elections', async (_req, res) => {
  try {
    const elections = await prisma.election.findMany({
      include: {
        _count: { select: { candidates: true, stations: true } },
        submissions: { select: { stationId: true } },
        organization: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({
      elections: elections.map((e) => ({
        id: e.id,
        name: e.name,
        status: e.status,
        organizationName: e.organization?.name || '',
        gpsRequired: e.gpsRequired,
        qrRequired: e.qrRequired,
        candidateCount: e._count.candidates,
        stationCount: e._count.stations,
        reportedCount: new Set(e.submissions.map((s) => s.stationId)).size,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/elections/:id/dashboard', async (req, res) => {
  try {
    const elId = parseInt(req.params.id);
    if (isNaN(elId)) return res.status(404).json({ error: 'not found' });
    const el = await prisma.election.findUnique({
      where: { id: elId },
      include: {
        candidates: { orderBy: { sortOrder: 'asc' } },
        stations: {
          include: { region: true },
          orderBy: { id: 'asc' },
        },
        submissions: true,
        regions: { orderBy: { id: 'asc' } },
      },
    });
    if (!el) return res.status(404).json({ error: 'not found' });

    const candidates = el.candidates.map((c) => ({ id: c.id, cid: c.id, name: c.name }));
    const results = el.submissions.map((s) => ({
      sid: s.stationId,
      tx_id: s.txHash,
      votes: s.votes || {},
      tot: null,
      inv: null,
      created_at: s.chainTimestamp ? s.chainTimestamp.toISOString() : s.indexedAt.toISOString(),
      submitter_pubkey: s.submitterPubkey,
    }));
    const latest = latestPerStation(results);
    const tally = computeTally(candidates, latest);
    const prog = reporting(el.stations.map((s) => ({ sid: s.id })), latest);

    const regionalBreakdown = el.regions.map((r) => {
      const regionStations = el.stations.filter((s) => s.regionId === r.id);
      const reported = regionStations.filter((s) => latest.has(s.id)).length;
      return { regionId: r.id, regionName: r.name, total: regionStations.length, reported };
    });

    const perStation = el.stations.map((s) => {
      const r = latest.get(s.id);
      return {
        id: s.id,
        name: s.name,
        code: s.code,
        regionName: s.region?.name || '',
        reported: !!r,
        votes: r ? r.votes : null,
        at: r ? r.created_at : null,
        submitter: r ? r.submitter_pubkey : null,
      };
    });

    let lastUpdated = null;
    for (const r of results) {
      if (r.created_at && (!lastUpdated || r.created_at > lastUpdated)) lastUpdated = r.created_at;
    }

    res.json({
      election: { id: el.id, name: el.name, status: el.status, gpsRequired: el.gpsRequired, qrRequired: el.qrRequired },
      candidates,
      tally,
      reporting: prog,
      regionalBreakdown,
      stations: perStation,
      lastUpdated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/elections/:id/stations', async (req, res) => {
  try {
    const elId = parseInt(req.params.id);
    if (isNaN(elId)) return res.status(404).json({ error: 'not found' });
    const stations = await prisma.pollingStation.findMany({
      where: { electionId: elId },
      include: { region: true, agents: true },
      orderBy: { id: 'asc' },
    });
    res.json({
      stations: stations.map((s) => ({
        id: s.id,
        name: s.name,
        code: s.code,
        regionId: s.regionId,
        regionName: s.region?.name || '',
        latitude: s.latitude,
        longitude: s.longitude,
        totalRegisteredVoters: s.totalRegisteredVoters,
        agents: s.agents.map((a) => ({ userId: a.userId, username: a.username })),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Explorer ─────────────────────────────────────────────────────────────────

app.get('/api/explorer', async (req, res) => {
  try {
    const { electionId, stationId, txHash, page = '1' } = req.query;
    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = 20;
    const where = {};
    if (electionId) where.electionId = parseInt(electionId);
    if (stationId) where.stationId = parseInt(stationId);
    if (txHash) where.txHash = { contains: txHash };

    const [total, rows] = await Promise.all([
      prisma.cachedSubmission.count({ where }),
      prisma.cachedSubmission.findMany({
        where,
        include: { station: { include: { region: true } }, election: { select: { name: true } } },
        orderBy: { blockHeight: 'desc' },
        skip: (pageNum - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    res.json({
      total,
      page: pageNum,
      pageSize,
      submissions: rows.map((s) => ({
        id: s.id,
        txHash: s.txHash,
        electionId: s.electionId,
        electionName: s.election?.name || '',
        stationId: s.stationId,
        stationName: s.station?.name || '',
        regionName: s.station?.region?.name || '',
        submitterPubkey: s.submitterPubkey,
        submitterUsername: s.submitterUsername,
        blockHeight: s.blockHeight,
        chainTimestamp: s.chainTimestamp,
        indexedAt: s.indexedAt,
        votes: s.votes,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Agent routes ──────────────────────────────────────────────────────────────

app.get('/api/station/mine', requireRole('agent'), async (req, res) => {
  try {
    const assignment = await prisma.stationAgent.findFirst({
      where: { userId: req.user.id },
      include: {
        station: {
          include: {
            region: true,
            election: { include: { candidates: { orderBy: { sortOrder: 'asc' } } } },
          },
        },
      },
    });
    if (!assignment) return res.status(404).json({ error: 'No station assigned' });

    const submitted = await prisma.cachedSubmission.findFirst({
      where: { stationId: assignment.stationId, submitterUserId: req.user.id },
      orderBy: { indexedAt: 'desc' },
    });

    res.json({
      station: {
        id: assignment.station.id,
        name: assignment.station.name,
        code: assignment.station.code,
        regionName: assignment.station.region?.name || '',
        totalRegisteredVoters: assignment.station.totalRegisteredVoters,
        latitude: assignment.station.latitude,
        longitude: assignment.station.longitude,
        electionId: assignment.station.electionId,
        electionName: assignment.station.election?.name || '',
        gpsRequired: assignment.station.election?.gpsRequired || false,
        gpsRadiusMeters: assignment.station.election?.gpsRadiusMeters || null,
        qrRequired: assignment.station.election?.qrRequired || false,
        candidates: assignment.station.election?.candidates || [],
      },
      submitted: !!submitted,
      lastSubmission: submitted
        ? { txHash: submitted.txHash, at: submitted.chainTimestamp, votes: submitted.votes }
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function gpsDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

app.post('/api/submit', requireRole('agent'), upload.single('photo'), async (req, res) => {
  try {
    const { electionId, stationId, votes: votesStr, gpsLat, gpsLng } = req.body || {};
    const elId = parseInt(electionId);
    const stId = parseInt(stationId);
    if (isNaN(elId) || isNaN(stId)) return res.status(400).json({ error: 'electionId and stationId required' });

    const [station, election, assignment] = await Promise.all([
      prisma.pollingStation.findUnique({ where: { id: stId } }),
      prisma.election.findUnique({ where: { id: elId } }),
      prisma.stationAgent.findFirst({ where: { userId: req.user.id, stationId: stId } }),
    ]);
    if (!station || !election) return res.status(404).json({ error: 'not found' });
    if (!assignment && req.role !== 'admin') {
      return res.status(403).json({ error: 'Not assigned to this station' });
    }

    if (election.gpsRequired && gpsLat && gpsLng && station.latitude && station.longitude) {
      const dist = gpsDistance(parseFloat(gpsLat), parseFloat(gpsLng), station.latitude, station.longitude);
      const radius = election.gpsRadiusMeters || 500;
      if (dist > radius) {
        return res.status(400).json({ error: 'Outside allowed GPS radius', distance: Math.round(dist), radius });
      }
    }

    let votes = {};
    try { votes = JSON.parse(votesStr || '{}'); } catch {}

    let photoFilename = null;
    if (req.file) {
      photoFilename = await storage.savePhoto(req.file.buffer, req.file.originalname);
    }

    const memoStr = JSON.stringify(resultMemo(String(elId), stId, votes, null, null));
    const appPubkey = process.env.APP_PUBKEY || 'local';
    const { txHash } = await blockchain.broadcastTx({ memo: memoStr, toPubkey: appPubkey });
    const conf = await blockchain.waitForConfirmation(txHash, 60000);

    await prisma.cachedSubmission.upsert({
      where: { txHash },
      create: {
        txHash,
        stationId: stId,
        electionId: elId,
        submitterUserId: req.user.id,
        submitterUsername: req.user.username,
        submitterPubkey: req.user.usernode_pubkey || '',
        votes,
        photoFilename,
        blockHeight: conf.blockHeight || 0,
        chainTimestamp: conf.chainTimestamp || new Date(),
      },
      update: {
        votes,
        photoFilename: photoFilename || undefined,
        blockHeight: conf.blockHeight || 0,
        chainTimestamp: conf.chainTimestamp || new Date(),
        indexedAt: new Date(),
      },
    });

    res.json({ ok: true, txHash, confirmed: conf.confirmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin routes ──────────────────────────────────────────────────────────────

app.get('/api/admin/organizations', requireRole('admin'), async (_req, res) => {
  try {
    const orgs = await prisma.organization.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ organizations: orgs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/organizations', requireRole('admin'), async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const org = await prisma.organization.create({ data: { name: String(name) } });
    res.json({ organization: org });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/elections', requireRole('admin'), async (req, res) => {
  try {
    const { organizationId, name, status = 'active', gpsRequired = false, gpsRadiusMeters, qrRequired = false, candidates = [], regions = [] } = req.body || {};
    if (!organizationId || !name) return res.status(400).json({ error: 'organizationId and name required' });

    const el = await prisma.election.create({
      data: {
        organizationId: parseInt(organizationId),
        name: String(name),
        status: String(status),
        gpsRequired: Boolean(gpsRequired),
        gpsRadiusMeters: gpsRadiusMeters ? parseInt(gpsRadiusMeters) : null,
        qrRequired: Boolean(qrRequired),
        candidates: {
          create: candidates.map((c, i) => ({ name: String(c.name || c), sortOrder: i + 1 })),
        },
        regions: {
          create: regions.map((r) => ({ name: String(r.name || r) })),
        },
      },
      include: { candidates: true, regions: true },
    });
    res.json({ election: el });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/elections/:id', requireRole('admin'), async (req, res) => {
  try {
    const elId = parseInt(req.params.id);
    if (isNaN(elId)) return res.status(404).json({ error: 'not found' });
    const { name, status, gpsRequired, gpsRadiusMeters, qrRequired } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = String(name);
    if (status !== undefined) data.status = String(status);
    if (gpsRequired !== undefined) data.gpsRequired = Boolean(gpsRequired);
    if (gpsRadiusMeters !== undefined) data.gpsRadiusMeters = gpsRadiusMeters ? parseInt(gpsRadiusMeters) : null;
    if (qrRequired !== undefined) data.qrRequired = Boolean(qrRequired);
    const el = await prisma.election.update({ where: { id: elId }, data });
    res.json({ election: el });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/elections/:id/stations', requireRole('admin'), async (req, res) => {
  try {
    const elId = parseInt(req.params.id);
    if (isNaN(elId)) return res.status(404).json({ error: 'not found' });
    const { regionId, name, code, latitude, longitude, totalRegisteredVoters } = req.body || {};
    if (!regionId || !name || !code) return res.status(400).json({ error: 'regionId, name and code required' });
    const station = await prisma.pollingStation.create({
      data: {
        electionId: elId,
        regionId: parseInt(regionId),
        name: String(name),
        code: String(code),
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        totalRegisteredVoters: totalRegisteredVoters ? parseInt(totalRegisteredVoters) : null,
      },
    });
    res.json({ station });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/stations/:id/agents', requireRole('admin'), async (req, res) => {
  try {
    const stId = parseInt(req.params.id);
    if (isNaN(stId)) return res.status(404).json({ error: 'not found' });
    const { userId, username } = req.body || {};
    if (!userId || !username) return res.status(400).json({ error: 'userId and username required' });
    const agent = await prisma.stationAgent.create({
      data: { stationId: stId, userId: String(userId), username: String(username) },
    });
    res.json({ agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/stations/:id/agents/:userId', requireRole('admin'), async (req, res) => {
  try {
    const stId = parseInt(req.params.id);
    const userId = req.params.userId;
    await prisma.stationAgent.deleteMany({ where: { stationId: stId, userId } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reindex', requireRole('admin'), async (_req, res) => {
  try {
    await prisma.cachedSubmission.deleteMany({});
    await prisma.indexerState.upsert({
      where: { id: 1 },
      create: { id: 1, lastIndexedBlock: 0, lastIndexedAt: new Date() },
      update: { lastIndexedBlock: 0, lastIndexedAt: new Date() },
    });
    pollOnce(prisma).catch((e) => console.error('reindex pollOnce failed:', e.message));
    res.json({ ok: true, message: 'Re-index started' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit', requireRole('admin'), async (_req, res) => {
  try {
    const rows = await prisma.cachedSubmission.findMany({
      include: { station: { select: { name: true } }, election: { select: { name: true } } },
      orderBy: { indexedAt: 'desc' },
      take: 100,
    });
    res.json({
      submissions: rows.map((s) => ({
        id: s.id,
        txHash: s.txHash,
        electionName: s.election?.name || '',
        stationName: s.station?.name || '',
        submitterUsername: s.submitterUsername,
        submitterPubkey: s.submitterPubkey,
        blockHeight: s.blockHeight,
        chainTimestamp: s.chainTimestamp,
        indexedAt: s.indexedAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTML shell ───────────────────────────────────────────────────────────────
// Serve index.html for all remaining GET requests. Unauthenticated users see
// a read-only view using the public API.
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Staging seed data ─────────────────────────────────────────────────────────

async function seedStaging() {
  if (!IS_STAGING) return;

  await prisma.organization.upsert({
    where: { id: 1 },
    create: { id: 1, name: 'Staging Demo Electoral Commission' },
    update: {},
  });

  await prisma.election.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      organizationId: 1,
      name: 'Staging Demo General Election 2026',
      status: 'active',
      gpsRequired: false,
      qrRequired: false,
    },
    update: {},
  });

  await prisma.candidate.createMany({
    data: [
      { id: 1, electionId: 1, name: 'Alpha', sortOrder: 1 },
      { id: 2, electionId: 1, name: 'Beta', sortOrder: 2 },
      { id: 3, electionId: 1, name: 'Gamma', sortOrder: 3 },
    ],
    skipDuplicates: true,
  });

  await prisma.region.createMany({
    data: [
      { id: 1, electionId: 1, name: 'Northern' },
      { id: 2, electionId: 1, name: 'Southern' },
    ],
    skipDuplicates: true,
  });

  const stations = [
    { id: 1, electionId: 1, regionId: 1, name: 'Staging Station N-1', code: 'N-1' },
    { id: 2, electionId: 1, regionId: 1, name: 'Staging Station N-2', code: 'N-2' },
    { id: 3, electionId: 1, regionId: 1, name: 'Staging Station N-3', code: 'N-3' },
    { id: 4, electionId: 1, regionId: 1, name: 'Staging Station N-4', code: 'N-4' },
    { id: 5, electionId: 1, regionId: 1, name: 'Staging Station N-5', code: 'N-5' },
    { id: 6, electionId: 1, regionId: 2, name: 'Staging Station S-1', code: 'S-1' },
    { id: 7, electionId: 1, regionId: 2, name: 'Staging Station S-2', code: 'S-2' },
    { id: 8, electionId: 1, regionId: 2, name: 'Staging Station S-3', code: 'S-3' },
    { id: 9, electionId: 1, regionId: 2, name: 'Staging Station S-4', code: 'S-4' },
    { id: 10, electionId: 1, regionId: 2, name: 'Staging Station S-5', code: 'S-5' },
  ];
  await prisma.pollingStation.createMany({ data: stations, skipDuplicates: true });

  await prisma.userRole.upsert({
    where: { userId: 'staging-admin-001' },
    create: { userId: 'staging-admin-001', username: 'staging_admin', role: 'admin' },
    update: {},
  });

  await prisma.stationAgent.createMany({
    data: [{ id: 1, stationId: 1, userId: 'staging-agent-001', username: 'staging_agent' }],
    skipDuplicates: true,
  });

  const submissions = [
    { id: 1, txHash: 'staging-tx-0001', stationId: 1, electionId: 1, submitterUserId: 'staging-agent-001', submitterUsername: 'staging_agent', submitterPubkey: 'ut1staging000000000000000000000001', votes: { 1: 120, 2: 85, 3: 45 }, blockHeight: 1000, chainTimestamp: new Date('2026-06-20T08:00:00Z') },
    { id: 2, txHash: 'staging-tx-0002', stationId: 2, electionId: 1, submitterUserId: 'staging-agent-002', submitterUsername: 'staging_agent_2', submitterPubkey: 'ut1staging000000000000000000000002', votes: { 1: 98, 2: 110, 3: 62 }, blockHeight: 1010, chainTimestamp: new Date('2026-06-20T08:15:00Z') },
    { id: 3, txHash: 'staging-tx-0003', stationId: 3, electionId: 1, submitterUserId: 'staging-agent-003', submitterUsername: 'staging_agent_3', submitterPubkey: 'ut1staging000000000000000000000003', votes: { 1: 145, 2: 72, 3: 38 }, blockHeight: 1020, chainTimestamp: new Date('2026-06-20T08:30:00Z') },
    { id: 4, txHash: 'staging-tx-0004', stationId: 6, electionId: 1, submitterUserId: 'staging-agent-004', submitterUsername: 'staging_agent_4', submitterPubkey: 'ut1staging000000000000000000000004', votes: { 1: 88, 2: 95, 3: 77 }, blockHeight: 1030, chainTimestamp: new Date('2026-06-20T09:00:00Z') },
    { id: 5, txHash: 'staging-tx-0005', stationId: 7, electionId: 1, submitterUserId: 'staging-agent-005', submitterUsername: 'staging_agent_5', submitterPubkey: 'ut1staging000000000000000000000005', votes: { 1: 201, 2: 133, 3: 56 }, blockHeight: 1050, chainTimestamp: new Date('2026-06-20T09:30:00Z') },
    { id: 6, txHash: 'staging-tx-0006', stationId: 8, electionId: 1, submitterUserId: 'staging-agent-006', submitterUsername: 'staging_agent_6', submitterPubkey: 'ut1staging000000000000000000000006', votes: { 1: 167, 2: 89, 3: 104 }, blockHeight: 1060, chainTimestamp: new Date('2026-06-20T10:00:00Z') },
  ];
  await prisma.cachedSubmission.createMany({ data: submissions, skipDuplicates: true });

  await prisma.indexerState.upsert({
    where: { id: 1 },
    create: { id: 1, lastIndexedBlock: 1060, lastIndexedAt: new Date() },
    update: { lastIndexedBlock: 1060 },
  });

  // Reset PostgreSQL sequences so auto-increment works after explicit-ID inserts.
  const tables = [
    ['Organization', 'Organization_id_seq'],
    ['Election', 'Election_id_seq'],
    ['Candidate', 'Candidate_id_seq'],
    ['Region', 'Region_id_seq'],
    ['PollingStation', 'PollingStation_id_seq'],
    ['StationAgent', 'StationAgent_id_seq'],
    ['UserRole', 'UserRole_id_seq'],
    ['CachedSubmission', 'CachedSubmission_id_seq'],
  ];
  for (const [table, seq] of tables) {
    await prisma.$queryRawUnsafe(
      `SELECT setval('"${seq}"', COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`
    ).catch(() => {});
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function start() {
  await seedStaging();
  setInterval(() => pollOnce(prisma).catch((e) => console.error('pollOnce failed:', e.message)), 10000);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch((err) => { console.error(err); process.exit(1); });

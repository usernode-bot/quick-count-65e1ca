'use strict';
const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const txsource = require('./lib/txsource');
const { normalizeTx, applyTx } = require('./lib/indexer');
const { aggregate, latestPerStation, computeTally, reporting } = require('./lib/aggregate');
const { verifyPayment } = require('./lib/unlock');
const blockchain = require('./lib/blockchain');
const storage = require('./lib/storage');
const memo = require('./lib/memo');
const { isKind, validateImageUpload } = require('./lib/attach');

const app = express();
const port = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const prisma = new PrismaClient();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Pay-to-unlock config ─────────────────────────────────────────────────────
// The recipient address and price are configured via dapp.json secrets. The
// network is currently a test/mock-token network; switching to mainnet is just
// setting UNLOCK_RECIPIENT_ADDRESS to a real wallet — no code changes.
const UNLOCK_RECIPIENT = process.env.UNLOCK_RECIPIENT_ADDRESS || '';
const UNLOCK_PRICE = Math.max(0, parseInt(process.env.UNLOCK_PRICE_TOKENS || '0', 10) || 0);
const UNLOCK_ENABLED = !!UNLOCK_RECIPIENT;

// ── Auth & role middleware ───────────────────────────────────────────────────
const PUBLIC_API_PATHS = new Set(['/health']);
const PUBLIC_PREFIXES = ['/explorer-api/', '/api/public/'];
const ROLE_ORDER = ['observer', 'org_staff', 'org_admin', 'platform_admin'];

async function resolveRole(pubkey) {
  if (!pubkey) return { role: 'observer', orgIds: [], isMemberOf: [] };

  const ur = await prisma.userRole.findUnique({ where: { userId: pubkey } });
  if (ur && ur.role === 'platform_admin') {
    return { role: 'platform_admin', orgIds: [], isMemberOf: [] };
  }

  const ownedOrgs = await prisma.organization.findMany({ where: { ownerPubkey: pubkey, status: 'registered' } });
  const orgIds = ownedOrgs.map((o) => o.id);

  const memberships = await prisma.orgMember.findMany({
    where: { memberPubkey: pubkey },
    include: { org: { select: { id: true, status: true } } },
  });
  const isMemberOf = memberships.filter((m) => m.org.status === 'registered').map((m) => m.orgId);

  if (orgIds.length > 0) return { role: 'org_admin', orgIds, isMemberOf };
  if (isMemberOf.length > 0) return { role: 'org_staff', orgIds: [], isMemberOf };
  return { role: 'observer', orgIds: [], isMemberOf: [] };
}

function requireRole(minRole) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    const { role, orgIds, isMemberOf } = await resolveRole(req.user.usernode_pubkey);
    req.role = role;
    req.orgIds = orgIds;
    req.isMemberOf = isMemberOf;
    if (ROLE_ORDER.indexOf(role) < ROLE_ORDER.indexOf(minRole)) {
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
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// Attach role for authenticated requests (lazy, only on api routes that need it)
async function withRole(req) {
  if (!req.user) { req.role = 'observer'; req.orgIds = []; req.isMemberOf = []; return; }
  const r = await resolveRole(req.user.usernode_pubkey);
  req.role = r.role; req.orgIds = r.orgIds; req.isMemberOf = r.isMemberOf;
}

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

// ── Visibility helpers ───────────────────────────────────────────────────────

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

function canSeeElection(election, role, orgIds, isMemberOf) {
  const now = new Date();
  if (election.visibility === 'public') return true;
  if (election.visibility === 'public_after_close') {
    if (election.closedAt && new Date(election.closedAt) < now) return true;
  }
  if (role === 'platform_admin') return true;
  const allOrgIds = [...(orgIds || []), ...(isMemberOf || [])];
  if (election.visibility === 'private' || election.visibility === 'public_after_close') {
    return allOrgIds.includes(election.orgId);
  }
  if (election.visibility === 'hidden') return false;
  return false;
}

// ── Health ───────────────────────────────────────────────────────────────────

app.get('/health', (req, res) => res.json({ ok: true }));

// ── Public routes ────────────────────────────────────────────────────────────

app.get('/api/public/elections', async (req, res) => {
  try {
    const now = new Date();
    const elections = await prisma.election.findMany({
      where: {
        OR: [
          { visibility: 'public' },
          { visibility: 'public_after_close', closedAt: { lte: now } },
        ],
      },
      include: { org: { select: { name: true } }, candidates: true, stations: true },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ elections });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/public/elections/:txHash', async (req, res) => {
  try {
    const el = await prisma.election.findUnique({
      where: { txHash: req.params.txHash },
      include: { org: true, candidates: { orderBy: { displayOrder: 'asc' } }, stations: true },
    });
    if (!el) return res.status(404).json({ error: 'Not found' });
    const now = new Date();
    if (el.visibility !== 'public' && !(el.visibility === 'public_after_close' && el.closedAt && new Date(el.closedAt) < now)) {
      return res.status(404).json({ error: 'Not found' });
    }
    const submissions = await prisma.cachedSubmission.findMany({ where: { electionId: el.id } });
    const agg = aggregate(el.aggregation, submissions, el.candidates, el.stations, el.manualTally);
    res.json({ election: el, ...agg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Off-chain image attachments ──────────────────────────────────────────────
// Candidate avatars and station C1-form scans stored in the `attachments` table.
// Keyed by eid (election txHash) + kind + ref_id so uploads work before indexing.

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

    await prisma.$executeRawUnsafe(
      `INSERT INTO attachments (eid, kind, ref_id, mime, bytes, byte_size, uploader_pubkey, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (eid, kind, ref_id)
       DO UPDATE SET mime = EXCLUDED.mime, bytes = EXCLUDED.bytes,
                     byte_size = EXCLUDED.byte_size, uploader_pubkey = EXCLUDED.uploader_pubkey,
                     updated_at = NOW()`,
      eid, kind, refId, mime, buf, buf.length, (req.user && req.user.usernode_pubkey) || null
    );
    res.json({ ok: true, eid, kind, ref_id: refId, byte_size: buf.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/elections/:eid/attachments/:kind/:refId', async (req, res) => {
  try {
    const { eid, kind } = req.params;
    const refId = Number(req.params.refId);
    if (!isKind(kind) || !Number.isInteger(refId) || refId <= 0) {
      return res.status(404).json({ error: 'not found' });
    }
    const rows = await prisma.$queryRawUnsafe(
      'SELECT mime, bytes FROM attachments WHERE eid = $1 AND kind = $2 AND ref_id = $3',
      eid, kind, refId
    );
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    res.set('Content-Type', rows[0].mime);
    res.set('Cache-Control', 'public, max-age=60');
    res.send(rows[0].bytes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/public/orgs', async (req, res) => {
  try {
    const orgs = await prisma.organization.findMany({ where: { status: 'registered' }, orderBy: { createdAt: 'desc' } });
    res.json({ orgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Authenticated routes ─────────────────────────────────────────────────────

app.get('/api/me', async (req, res) => {
  try {
    await withRole(req);
    res.json({ pubkey: req.user.usernode_pubkey, role: req.role, orgIds: req.orgIds, isMemberOf: req.isMemberOf });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Public election detail with pay-to-unlock gate ───────────────────────────
app.get('/api/public/elections/:eid', async (req, res) => {
  try {
    const eid = req.params.eid;
    const el = (await pool.query('SELECT eid, name, root_pubkey, created_at FROM elections WHERE eid = $1', [eid])).rows[0];
    if (!el) return res.status(404).json({ error: 'not found' });

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

    if (await walletUnlocked(pubkey)) return res.json({ unlocked: true });

    if (IS_STAGING) {
      await pool.query(
        `INSERT INTO unlocks (usernode_pubkey, tx_id, amount, recipient, created_at)
         VALUES ($1, $2, $3, $4, NOW()) ON CONFLICT (usernode_pubkey) DO NOTHING`,
        [pubkey, 'staging-demo-' + pubkey, UNLOCK_PRICE, UNLOCK_RECIPIENT]
      );
      return res.json({ unlocked: true, demo: true });
    }

    const { tx_id } = req.body || {};
    if (!tx_id) return res.status(400).json({ error: 'tx_id required' });

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
      return res.status(400).json({ error: 'This payment has already been used' });
    }
    res.json({ unlocked: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/elections', async (req, res) => {
  try {
    await withRole(req);
    const all = await prisma.election.findMany({
      include: { org: { select: { name: true } }, candidates: true, stations: true },
      orderBy: { createdAt: 'desc' },
    });
    const visible = all.filter((el) => canSeeElection(el, req.role, req.orgIds, req.isMemberOf));
    res.json({ elections: visible });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/elections/:txHash', async (req, res) => {
  try {
    await withRole(req);
    const el = await prisma.election.findUnique({
      where: { txHash: req.params.txHash },
      include: { org: true, candidates: { orderBy: { displayOrder: 'asc' } }, stations: true },
    });
    if (!el || !canSeeElection(el, req.role, req.orgIds, req.isMemberOf)) return res.status(404).json({ error: 'Not found' });
    res.json({ election: el });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/elections/:txHash/dashboard', async (req, res) => {
  try {
    await withRole(req);
    const el = await prisma.election.findUnique({
      where: { txHash: req.params.txHash },
      include: { candidates: { orderBy: { displayOrder: 'asc' } }, stations: true, org: { select: { name: true } } },
    });
    if (!el || !canSeeElection(el, req.role, req.orgIds, req.isMemberOf)) return res.status(404).json({ error: 'Not found' });
    const submissions = await prisma.cachedSubmission.findMany({ where: { electionId: el.id } });
    const agg = aggregate(el.aggregation, submissions, el.candidates, el.stations, el.manualTally);
    res.json({ election: el, ...agg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/elections/:txHash/stations', async (req, res) => {
  try {
    await withRole(req);
    const el = await prisma.election.findUnique({ where: { txHash: req.params.txHash } });
    if (!el || !canSeeElection(el, req.role, req.orgIds, req.isMemberOf)) return res.status(404).json({ error: 'Not found' });
    const stations = await prisma.station.findMany({
      where: { electionId: el.id },
      include: { submissions: { orderBy: { chainTimestamp: 'desc' }, take: 1 } },
    });
    res.json({ stations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orgs', async (req, res) => {
  try {
    await withRole(req);
    const where = req.role === 'platform_admin' ? {} : { status: 'registered' };
    const orgs = await prisma.organization.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ orgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/orgs/:txHash', async (req, res) => {
  try {
    await withRole(req);
    const org = await prisma.organization.findUnique({ where: { txHash: req.params.txHash }, include: { members: true } });
    if (!org) return res.status(404).json({ error: 'Not found' });
    if (org.status !== 'registered' && req.role !== 'platform_admin' && !req.orgIds.includes(org.id)) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json({ org });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/evidence', async (req, res) => {
  try {
    const where = {};
    if (req.query.election) {
      const el = await prisma.election.findUnique({ where: { txHash: req.query.election } });
      if (el) where.electionId = el.id;
    }
    if (req.query.submission) {
      const sub = await prisma.cachedSubmission.findUnique({ where: { txHash: req.query.submission } });
      if (sub) where.submissionId = sub.id;
    }
    const records = await prisma.evidenceRecord.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ records });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/disputes', async (req, res) => {
  try {
    const where = {};
    if (req.query.election) {
      const el = await prisma.election.findUnique({ where: { txHash: req.query.election } });
      if (el) where.electionId = el.id;
    }
    if (req.query.status) where.status = req.query.status;
    const disputes = await prisma.dispute.findMany({ where, orderBy: { createdAt: 'desc' } });
    res.json({ disputes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/explorer', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const where = {};
    if (req.query.election) {
      const el = await prisma.election.findUnique({ where: { txHash: req.query.election } });
      if (el) where.electionId = el.id;
    }
    if (req.query.txHash) where.txHash = { contains: req.query.txHash };
    const [total, items] = await Promise.all([
      prisma.cachedSubmission.count({ where }),
      prisma.cachedSubmission.findMany({ where, orderBy: { chainTimestamp: 'desc' }, skip: (page - 1) * limit, take: limit }),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Org Staff+ routes ────────────────────────────────────────────────────────

app.post('/api/submit', upload.single('photo'), requireRole('org_staff'), async (req, res) => {
  try {
    const { election_id, station_id, votes: votesRaw, ref_tx_id } = req.body;
    if (!election_id || !station_id) return res.status(400).json({ error: 'election_id and station_id required' });

    const el = await prisma.election.findUnique({ where: { txHash: election_id } });
    const stn = await prisma.station.findUnique({ where: { txHash: station_id } });
    if (!el || !stn) return res.status(404).json({ error: 'Election or station not found' });

    let votes = {};
    try { votes = typeof votesRaw === 'string' ? JSON.parse(votesRaw) : (votesRaw || {}); } catch {}

    const pubkey = req.user.usernode_pubkey || '';
    let txHash;
    if (ref_tx_id) {
      const m = memo.resultReviseMemo(election_id, station_id, votes, ref_tx_id);
      const result = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });
      txHash = result.txHash;
      await prisma.cachedSubmission.updateMany({ where: { txHash: ref_tx_id }, data: { status: 'revised' } });
    } else {
      const m = memo.resultSubmitMemo(election_id, station_id, votes);
      const result = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });
      txHash = result.txHash;
    }

    let photoFilename = null;
    if (req.file) {
      photoFilename = await storage.savePhoto(req.file.buffer, req.file.originalname);
    }

    await prisma.cachedSubmission.upsert({
      where: { txHash },
      create: {
        txHash,
        stationId: stn.id,
        electionId: el.id,
        submitterPubkey: pubkey,
        votes,
        refTxHash: ref_tx_id || null,
        blockHeight: 0,
        chainTimestamp: new Date(),
        status: 'ok',
      },
      update: { votes, indexedAt: new Date() },
    });

    res.json({ txHash, photoFilename });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/evidence', upload.single('file'), requireRole('org_staff'), async (req, res) => {
  try {
    const { submission_id, sha256: clientSha256 } = req.body;
    if (!submission_id) return res.status(400).json({ error: 'submission_id required' });

    const sub = await prisma.cachedSubmission.findUnique({ where: { txHash: submission_id } });
    if (!sub) return res.status(404).json({ error: 'Submission not found' });

    let filePath = '';
    let sha256 = clientSha256 || '';
    if (req.file) {
      filePath = await storage.savePhoto(req.file.buffer, req.file.originalname);
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      sha256 = hash;
    }

    const m = memo.evidenceSubmitMemo(submission_id, sha256, '');
    const { txHash } = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });

    const record = await prisma.evidenceRecord.upsert({
      where: { txHash },
      create: {
        txHash,
        submissionId: sub.id,
        electionId: sub.electionId,
        uploaderPubkey: req.user.usernode_pubkey || '',
        sha256,
        ipfsCid: '',
        ipfsStatus: 'pending',
        filePath,
      },
      update: {},
    });

    res.json({ record });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/disputes', requireRole('org_staff'), async (req, res) => {
  try {
    const { submission_id, reason } = req.body;
    if (!submission_id || !reason) return res.status(400).json({ error: 'submission_id and reason required' });

    const sub = await prisma.cachedSubmission.findUnique({ where: { txHash: submission_id } });
    if (!sub) return res.status(404).json({ error: 'Submission not found' });

    const m = memo.disputeOpenMemo(submission_id, reason);
    const { txHash } = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });

    const dispute = await prisma.dispute.upsert({
      where: { txHash },
      create: {
        txHash,
        submissionId: sub.id,
        electionId: sub.electionId,
        filerPubkey: req.user.usernode_pubkey || '',
        reason: String(reason).slice(0, 280),
        status: 'open',
      },
      update: {},
    });
    await prisma.cachedSubmission.updateMany({ where: { txHash: submission_id }, data: { status: 'disputed' } });

    res.json({ dispute });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Org Admin routes ─────────────────────────────────────────────────────────

app.post('/api/elections', requireRole('org_admin'), async (req, res) => {
  try {
    const { org_id, name, visibility, aggregation } = req.body;
    if (!org_id || !name) return res.status(400).json({ error: 'org_id and name required' });

    const org = await prisma.organization.findUnique({ where: { txHash: org_id } });
    if (!org || !req.orgIds.includes(org.id)) return res.status(403).json({ error: 'Not your org' });

    const m = memo.electionCreateMemo(org_id, name, visibility || 'public', aggregation || 'first_report');
    const { txHash } = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });

    const election = await prisma.election.upsert({
      where: { txHash },
      create: { txHash, orgId: org.id, name, visibility: visibility || 'public', aggregation: aggregation || 'first_report', status: 'open' },
      update: {},
    });
    res.json({ election });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/elections/:txHash', requireRole('org_admin'), async (req, res) => {
  try {
    const el = await prisma.election.findUnique({ where: { txHash: req.params.txHash } });
    if (!el || !req.orgIds.includes(el.orgId)) return res.status(403).json({ error: 'Not your election' });
    const { visibility, aggregation, status, closedAt, manualTally } = req.body;
    const data = {};
    if (visibility) data.visibility = visibility;
    if (aggregation) data.aggregation = aggregation;
    if (status) data.status = status;
    if (closedAt !== undefined) data.closedAt = closedAt ? new Date(closedAt) : null;
    if (manualTally !== undefined) data.manualTally = manualTally;
    const updated = await prisma.election.update({ where: { txHash: req.params.txHash }, data });
    res.json({ election: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/elections/:txHash/candidates', requireRole('org_admin'), async (req, res) => {
  try {
    const el = await prisma.election.findUnique({ where: { txHash: req.params.txHash } });
    if (!el || !req.orgIds.includes(el.orgId)) return res.status(403).json({ error: 'Not your election' });
    const { name, order } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const m = memo.candidateAddMemo(req.params.txHash, name, order || 0);
    const { txHash } = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });
    const candidate = await prisma.candidate.upsert({
      where: { txHash },
      create: { txHash, electionId: el.id, name, displayOrder: Number(order) || 0 },
      update: {},
    });
    res.json({ candidate });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/elections/:txHash/stations', requireRole('org_admin'), async (req, res) => {
  try {
    const el = await prisma.election.findUnique({ where: { txHash: req.params.txHash } });
    if (!el || !req.orgIds.includes(el.orgId)) return res.status(403).json({ error: 'Not your election' });
    const { name, region } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const m = memo.stationAddMemo(req.params.txHash, name, region || '');
    const { txHash } = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });
    const station = await prisma.station.upsert({
      where: { txHash },
      create: { txHash, electionId: el.id, name, region: region || '' },
      update: {},
    });
    res.json({ station });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/elections/:txHash/members', requireRole('org_admin'), async (req, res) => {
  try {
    const el = await prisma.election.findUnique({ where: { txHash: req.params.txHash }, include: { org: true } });
    if (!el || !req.orgIds.includes(el.orgId)) return res.status(403).json({ error: 'Not your election' });
    const { member_pubkey } = req.body;
    if (!member_pubkey) return res.status(400).json({ error: 'member_pubkey required' });
    const m = memo.orgMemberMemo(el.org.txHash, member_pubkey);
    const { txHash } = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });
    await prisma.orgMember.upsert({
      where: { grantTxHash: txHash },
      create: { grantTxHash: txHash, orgId: el.orgId, memberPubkey: member_pubkey },
      update: {},
    });
    res.json({ ok: true, txHash });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/disputes/:txHash/resolve', requireRole('org_admin'), async (req, res) => {
  try {
    const dispute = await prisma.dispute.findUnique({ where: { txHash: req.params.txHash } });
    if (!dispute) return res.status(404).json({ error: 'Not found' });
    const el = await prisma.election.findUnique({ where: { id: dispute.electionId } });
    const isAdmin = req.role === 'platform_admin';
    const isOrgAdmin = el && req.orgIds.includes(el.orgId);
    if (!isAdmin && !isOrgAdmin) return res.status(403).json({ error: 'Not authorized' });
    const { notes } = req.body;
    const m = memo.disputeResolveMemo(req.params.txHash, notes || '');
    const { txHash } = await blockchain.broadcastTx({ memo: memo.encode(m), toPubkey: process.env.APP_PUBKEY || '' });
    const updated = await prisma.dispute.update({
      where: { txHash: req.params.txHash },
      data: { status: 'resolved', resolvedAt: new Date(), resolvedBy: req.user.usernode_pubkey || '', resolution: notes || '', resolveTxHash: txHash },
    });
    res.json({ dispute: updated });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Platform Admin routes ────────────────────────────────────────────────────

app.get('/api/admin/orgs', requireRole('platform_admin'), async (req, res) => {
  try {
    const orgs = await prisma.organization.findMany({ orderBy: { createdAt: 'desc' } });
    res.json({ orgs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/orgs/:txHash/approve', requireRole('platform_admin'), async (req, res) => {
  try {
    const org = await prisma.organization.update({
      where: { txHash: req.params.txHash },
      data: { status: 'registered', registeredAt: new Date() },
    });
    res.json({ org });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/orgs/:txHash/reject', requireRole('platform_admin'), async (req, res) => {
  try {
    const org = await prisma.organization.update({ where: { txHash: req.params.txHash }, data: { status: 'rejected' } });
    res.json({ org });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/indexer', requireRole('platform_admin'), async (req, res) => {
  try {
    const state = await prisma.indexerState.findUnique({ where: { id: 1 } });
    res.json({ state });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/reindex', requireRole('platform_admin'), async (req, res) => {
  try {
    await prisma.indexerState.upsert({ where: { id: 1 }, create: { id: 1, lastIndexedBlock: 0 }, update: { lastIndexedBlock: 0 } });
    pollOnce(prisma).catch(console.error);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Static ───────────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS unlocks (
      usernode_pubkey TEXT PRIMARY KEY,
      tx_id TEXT UNIQUE,
      amount INTEGER,
      recipient TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`);
  await pool.query(`COMMENT ON TABLE unlocks IS 'staging:private'`);
  // Off-chain image attachments — PUBLIC table (candidate avatars + station C1 scans).
  // No FK to elections/candidates/stations so uploads work before indexing.
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

// ── Staging seed ─────────────────────────────────────────────────────────────

async function seedStaging() {
  if (!IS_STAGING) return;

  // Organizations
  await prisma.organization.upsert({
    where: { txHash: 'seed-org-1' },
    create: { id: 1, txHash: 'seed-org-1', ownerPubkey: 'seed-pubkey-admin', name: 'Demo Commission', description: 'Staging demo organisation', status: 'registered', feeConfirmed: true, registeredAt: new Date() },
    update: {},
  });

  // Elections
  await prisma.election.upsert({
    where: { txHash: 'seed-election-1' },
    create: { id: 1, txHash: 'seed-election-1', orgId: 1, name: 'Staging Demo General Election', visibility: 'public', aggregation: 'first_report', status: 'open' },
    update: {},
  });

  // Candidates
  await prisma.candidate.upsert({ where: { txHash: 'seed-cand-1' }, create: { id: 1, txHash: 'seed-cand-1', electionId: 1, name: 'Alpha', displayOrder: 1 }, update: {} });
  await prisma.candidate.upsert({ where: { txHash: 'seed-cand-2' }, create: { id: 2, txHash: 'seed-cand-2', electionId: 1, name: 'Beta', displayOrder: 2 }, update: {} });
  await prisma.candidate.upsert({ where: { txHash: 'seed-cand-3' }, create: { id: 3, txHash: 'seed-cand-3', electionId: 1, name: 'Gamma', displayOrder: 3 }, update: {} });

  // Stations
  await prisma.station.upsert({ where: { txHash: 'seed-stn-1' }, create: { id: 1, txHash: 'seed-stn-1', electionId: 1, name: 'Station North 1', region: 'North' }, update: {} });
  await prisma.station.upsert({ where: { txHash: 'seed-stn-2' }, create: { id: 2, txHash: 'seed-stn-2', electionId: 1, name: 'Station North 2', region: 'North' }, update: {} });
  await prisma.station.upsert({ where: { txHash: 'seed-stn-3' }, create: { id: 3, txHash: 'seed-stn-3', electionId: 1, name: 'Station South 1', region: 'South' }, update: {} });

  // UserRole
  await prisma.userRole.upsert({ where: { userId: 'seed-pubkey-admin' }, create: { userId: 'seed-pubkey-admin', role: 'platform_admin' }, update: {} });

  // OrgMember
  await prisma.orgMember.upsert({ where: { grantTxHash: 'seed-member-1' }, create: { id: 1, grantTxHash: 'seed-member-1', orgId: 1, memberPubkey: 'seed-pubkey-staff' }, update: {} });

  // Submissions
  const subs = [
    { id: 1, txHash: 'seed-sub-1', stationId: 1, votes: { 'seed-cand-1': 120, 'seed-cand-2': 85, 'seed-cand-3': 40 } },
    { id: 2, txHash: 'seed-sub-2', stationId: 1, votes: { 'seed-cand-1': 125, 'seed-cand-2': 83, 'seed-cand-3': 42 } },
    { id: 3, txHash: 'seed-sub-3', stationId: 2, votes: { 'seed-cand-1': 200, 'seed-cand-2': 150, 'seed-cand-3': 75 } },
    { id: 4, txHash: 'seed-sub-4', stationId: 2, votes: { 'seed-cand-1': 198, 'seed-cand-2': 152, 'seed-cand-3': 73 } },
    { id: 5, txHash: 'seed-sub-5', stationId: 3, votes: { 'seed-cand-1': 90, 'seed-cand-2': 60, 'seed-cand-3': 30 } },
    { id: 6, txHash: 'seed-sub-6', stationId: 3, votes: { 'seed-cand-1': 88, 'seed-cand-2': 62, 'seed-cand-3': 31 } },
  ];
  for (const s of subs) {
    await prisma.cachedSubmission.upsert({
      where: { txHash: s.txHash },
      create: { id: s.id, txHash: s.txHash, stationId: s.stationId, electionId: 1, submitterPubkey: 'seed-pubkey-staff', votes: s.votes, blockHeight: 100 + s.id, chainTimestamp: new Date(Date.now() - s.id * 60000), status: 'ok' },
      update: {},
    });
  }

  // Sequence resets
  for (const table of ['Organization', 'OrgMember', 'Election', 'Candidate', 'Station', 'CachedSubmission', 'EvidenceRecord', 'Dispute', 'UserRole']) {
    await prisma.$executeRawUnsafe(`SELECT setval('"${table}_id_seq"', COALESCE((SELECT MAX(id) FROM "${table}"), 0) + 1, false)`);
  }

  // Demo image attachments for the avatar/C1 UI: solid-colour 8×8 PNGs.
  const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4o6aGFTEMLQkAF/tKAS/fz4YAAAAASUVORK5CYII=';
  const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNQTX6NFTEMLQkADGRcwcht3uAAAAAASUVORK5CYII=';
  const GRAY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGMoLKzCihiGlgQA/HdXAZV6UO0AAAAASUVORK5CYII=';
  for (const [kind, refId, b64] of [['cand_avatar', 1, RED_PNG], ['cand_avatar', 2, BLUE_PNG], ['station_c1', 1, GRAY_PNG]]) {
    const buf = Buffer.from(b64, 'base64');
    await prisma.$executeRawUnsafe(
      `INSERT INTO attachments (eid, kind, ref_id, mime, bytes, byte_size, uploader_pubkey, updated_at)
       VALUES ('demo-election', $1, $2, 'image/png', $3, $4, $5, NOW())
       ON CONFLICT (eid, kind, ref_id) DO NOTHING`,
      kind, refId, buf, buf.length, 'seed-pubkey-admin'
    );
  }

  console.log('[seed] staging data inserted');
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function main() {
  await migrate();
  await seedStaging();

  // Indexer loop
  const indexerInterval = setInterval(() => pollOnce(prisma).catch(console.error), 10000);

  app.listen(port, () => console.log(`Quick Count v3 listening on :${port}`));

  process.on('SIGTERM', async () => {
    clearInterval(indexerInterval);
    await prisma.$disconnect();
    process.exit(0);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });

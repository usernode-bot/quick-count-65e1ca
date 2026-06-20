// Quick Count — transaction indexer.
//
// normalizeTx and applyTx are pure-ish functions over an abstract store so
// they can be unit-tested without a database. pollOnce(prisma) is the real
// Prisma-backed poll loop called by server.js.

const { decode } = require('./memo');
const txsource = require('./txsource');

function pickFirst(o, keys) {
  for (const k of keys) if (o[k] != null) return o[k];
  return null;
}

function normalizeTx(raw) {
  if (!raw || typeof raw !== 'object') return {};
  let txId = null;
  for (const v of [raw.id, raw.txid, raw.txId, raw.tx_id, raw.hash, raw.tx_hash, raw.txHash]) {
    if (typeof v === 'string' && v.trim()) { txId = v.trim(); break; }
  }
  const from = pickFirst(raw, ['from_pubkey', 'sender', 'account', 'from']);
  const to = pickFirst(raw, ['destination_pubkey', 'destination', 'to', 'recipient']);
  const memo = raw.memo == null ? null : String(raw.memo);
  const createdRaw = pickFirst(raw, ['created_at', 'createdAt', 'timestamp', 'time']);
  let createdAt = null;
  if (createdRaw != null) {
    const d = typeof createdRaw === 'number' ? new Date(createdRaw) : new Date(String(createdRaw));
    if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
  }
  const blockHeight = raw.blockHeight || raw.block_height || raw.height || 0;
  return {
    txId,
    from: from == null ? null : String(from),
    to: to == null ? null : String(to),
    memo,
    amount: raw.amount,
    createdAt,
    blockHeight: Number(blockHeight) || 0,
  };
}

async function applyTx(store, tx) {
  if (!tx || !tx.txId) return { applied: false, reason: 'no-txid' };
  const env = decode(tx.memo);
  if (!env) return { applied: false, reason: 'bad-memo' };
  const createdAt = tx.createdAt || null;

  if (env.t === 'el') {
    await store.putElection({
      eid: tx.txId,
      name: env.name || 'Untitled election',
      root_pubkey: tx.to || tx.from,
      creator_pubkey: tx.from,
      tx_id: tx.txId,
      created_at: createdAt,
    });
    return { applied: true, kind: 'el', eid: tx.txId };
  }

  if (env.t === 'cand' || env.t === 'stn') {
    const el = await store.getElection(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    if (el.creator_pubkey && tx.from && el.creator_pubkey !== tx.from) {
      return { applied: false, reason: 'unauthorized' };
    }
    if (env.t === 'cand') {
      if (!Number.isInteger(env.cid)) return { applied: false, reason: 'bad-cid' };
      await store.putCandidate({ eid: env.eid, cid: env.cid, name: env.name || ('Candidate ' + env.cid), tx_id: tx.txId });
      return { applied: true, kind: 'cand' };
    }
    if (!Number.isInteger(env.sid)) return { applied: false, reason: 'bad-sid' };
    await store.putStation({ eid: env.eid, sid: env.sid, name: env.name || ('Station ' + env.sid), tx_id: tx.txId });
    return { applied: true, kind: 'stn' };
  }

  if (env.t === 'res') {
    const el = await store.getElection(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    if (!Number.isInteger(env.sid)) return { applied: false, reason: 'bad-sid' };
    const votes = env.votes && typeof env.votes === 'object' ? env.votes : {};
    await store.upsertSubmission({
      txHash: tx.txId,
      stationId: env.sid,
      electionId: env.eid,
      submitterPubkey: tx.from || '',
      submitterUserId: '',
      submitterUsername: '',
      votes,
      blockHeight: tx.blockHeight || 0,
      chainTimestamp: createdAt ? new Date(createdAt) : new Date(),
    });
    return { applied: true, kind: 'res' };
  }

  return { applied: false, reason: 'unknown-type' };
}

function makePrismaStore(prisma) {
  return {
    async getElection(eid) {
      const id = parseInt(String(eid));
      if (isNaN(id)) return null;
      return prisma.election.findUnique({ where: { id } });
    },
    async putElection() {},
    async putCandidate() {},
    async putStation() {},
    async upsertSubmission(r) {
      if (!r.txHash || !r.stationId) return;
      const elId = typeof r.electionId === 'string' ? parseInt(r.electionId) : Number(r.electionId);
      if (isNaN(elId)) return;
      try {
        await prisma.cachedSubmission.upsert({
          where: { txHash: r.txHash },
          create: {
            txHash: r.txHash,
            stationId: Number(r.stationId),
            electionId: elId,
            submitterUserId: r.submitterUserId || '',
            submitterUsername: r.submitterUsername || '',
            submitterPubkey: r.submitterPubkey || '',
            votes: r.votes || {},
            blockHeight: r.blockHeight || 0,
            chainTimestamp: r.chainTimestamp instanceof Date ? r.chainTimestamp : new Date(r.chainTimestamp || Date.now()),
          },
          update: {
            votes: r.votes || {},
            blockHeight: r.blockHeight || 0,
            chainTimestamp: r.chainTimestamp instanceof Date ? r.chainTimestamp : new Date(r.chainTimestamp || Date.now()),
            indexedAt: new Date(),
          },
        });
      } catch (e) {
        console.error('upsertSubmission failed:', e.message);
      }
    },
  };
}

async function pollOnce(prisma) {
  let state = await prisma.indexerState.findUnique({ where: { id: 1 } });
  if (!state) {
    state = { id: 1, lastIndexedBlock: 0, lastIndexedAt: new Date() };
    await prisma.indexerState.create({ data: state });
  }

  let txs = [];
  try {
    txs = await txsource.listTransactions({ sinceCursor: String(state.lastIndexedBlock || '') });
  } catch (e) {
    console.error('txsource.listTransactions failed:', e.message);
    return;
  }
  if (!Array.isArray(txs) || !txs.length) return;

  const norm = txs.map(normalizeTx).filter((t) => t.txId);
  norm.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  const store = makePrismaStore(prisma);
  let maxBlock = state.lastIndexedBlock;

  for (const t of norm) {
    try {
      await applyTx(store, t);
      if (t.blockHeight && t.blockHeight > maxBlock) maxBlock = t.blockHeight;
    } catch (e) {
      console.error('applyTx failed:', e.message);
    }
  }

  if (maxBlock > state.lastIndexedBlock) {
    await prisma.indexerState.update({
      where: { id: 1 },
      data: { lastIndexedBlock: maxBlock, lastIndexedAt: new Date() },
    });
  }
}

module.exports = { normalizeTx, applyTx, pollOnce };

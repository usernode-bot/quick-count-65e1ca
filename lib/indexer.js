// Quick Count v3 — transaction indexer.
// normalizeTx and applyTx are pure-ish functions over an abstract store so
// they can be unit-tested without a database.

const { decode } = require('./memo');
const txsource = require('./txsource');

const APP_PUBKEY = process.env.APP_PUBKEY || '';
const REGISTRATION_FEE = 1000;

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
  const amount = raw.amount != null ? Number(raw.amount) : 0;
  return {
    txId,
    from: from == null ? null : String(from),
    to: to == null ? null : String(to),
    memo,
    amount,
    createdAt,
    blockHeight: Number(blockHeight) || 0,
  };
}

async function applyTx(store, tx) {
  if (!tx || !tx.txId) return { applied: false, reason: 'no-txid' };

  // Fee confirmation check: if this tx is a payment to APP_PUBKEY with sufficient amount,
  // find the matching org and confirm its fee.
  if (APP_PUBKEY && tx.to === APP_PUBKEY && tx.amount >= REGISTRATION_FEE) {
    const org = await store.getOrgByOwner(tx.from);
    if (org) {
      await store.confirmOrgFee(org.txHash);
    }
  }

  const env = decode(tx.memo);
  if (!env) return { applied: false, reason: 'bad-memo' };
  const createdAt = tx.createdAt || null;

  if (env.type === 'org_register') {
    await store.upsertOrg({
      txHash: tx.txId,
      ownerPubkey: tx.from || '',
      name: env.name || 'Unnamed Org',
      description: env.desc || '',
      status: 'pending',
      feeConfirmed: false,
    });
    return { applied: true, kind: 'org_register' };
  }

  if (env.type === 'election_create') {
    const org = await store.getOrg(env.org_id);
    if (!org) return { applied: false, reason: 'unknown-org' };
    if (org.status !== 'registered') return { applied: false, reason: 'org-not-registered' };
    if (org.ownerPubkey && tx.from && org.ownerPubkey !== tx.from) {
      return { applied: false, reason: 'unauthorized' };
    }
    const VALID_VIS = ['public', 'private', 'public_after_close', 'hidden'];
    const VALID_AGG = ['first_report', 'median', 'average', 'consensus', 'manual_review'];
    await store.upsertElection({
      txHash: tx.txId,
      orgId: org.id,
      name: env.name || 'Untitled Election',
      visibility: VALID_VIS.includes(env.visibility) ? env.visibility : 'public',
      aggregation: VALID_AGG.includes(env.agg) ? env.agg : 'first_report',
      status: 'open',
    });
    return { applied: true, kind: 'election_create' };
  }

  if (env.type === 'candidate_add') {
    const election = await store.getElection(env.election_id);
    if (!election) return { applied: false, reason: 'unknown-election' };
    const org = await store.getOrgById(election.orgId);
    if (!org) return { applied: false, reason: 'unknown-org' };
    const isOwner = org.ownerPubkey === tx.from;
    const isStaff = await store.isOrgMember(org.id, tx.from);
    if (!isOwner && !isStaff) return { applied: false, reason: 'unauthorized' };
    await store.upsertCandidate({
      txHash: tx.txId,
      electionId: election.id,
      name: env.name || 'Unnamed Candidate',
      displayOrder: Number(env.order) || 0,
    });
    return { applied: true, kind: 'candidate_add' };
  }

  if (env.type === 'station_add') {
    const election = await store.getElection(env.election_id);
    if (!election) return { applied: false, reason: 'unknown-election' };
    const org = await store.getOrgById(election.orgId);
    if (!org) return { applied: false, reason: 'unknown-org' };
    const isOwner = org.ownerPubkey === tx.from;
    const isStaff = await store.isOrgMember(org.id, tx.from);
    if (!isOwner && !isStaff) return { applied: false, reason: 'unauthorized' };
    await store.upsertStation({
      txHash: tx.txId,
      electionId: election.id,
      name: env.name || 'Unnamed Station',
      region: env.region || '',
    });
    return { applied: true, kind: 'station_add' };
  }

  if (env.type === 'org_member') {
    const org = await store.getOrg(env.org_id);
    if (!org) return { applied: false, reason: 'unknown-org' };
    if (org.ownerPubkey && tx.from && org.ownerPubkey !== tx.from) {
      return { applied: false, reason: 'unauthorized' };
    }
    await store.upsertOrgMember({
      orgId: org.id,
      memberPubkey: env.member || '',
      grantTxHash: tx.txId,
    });
    return { applied: true, kind: 'org_member' };
  }

  if (env.type === 'result_submit') {
    const election = await store.getElection(env.election_id);
    if (!election) return { applied: false, reason: 'unknown-election' };
    const station = await store.getStation(env.station_id);
    if (!station) return { applied: false, reason: 'unknown-station' };
    const votes = env.votes && typeof env.votes === 'object' ? env.votes : {};
    await store.upsertSubmission({
      txHash: tx.txId,
      stationId: station.id,
      electionId: election.id,
      submitterPubkey: tx.from || '',
      votes,
      totalVotes: env.total != null ? Number(env.total) : null,
      invalidVotes: env.invalid != null ? Number(env.invalid) : null,
      refTxHash: null,
      blockHeight: tx.blockHeight || 0,
      chainTimestamp: createdAt ? new Date(createdAt) : new Date(),
      status: 'ok',
    });
    return { applied: true, kind: 'result_submit' };
  }

  if (env.type === 'result_revise') {
    const election = await store.getElection(env.election_id);
    if (!election) return { applied: false, reason: 'unknown-election' };
    const station = await store.getStation(env.station_id);
    if (!station) return { applied: false, reason: 'unknown-station' };
    const votes = env.votes && typeof env.votes === 'object' ? env.votes : {};
    // Mark original submission as revised
    if (env.ref_tx_id) {
      await store.markSubmissionRevised(env.ref_tx_id);
    }
    await store.upsertSubmission({
      txHash: tx.txId,
      stationId: station.id,
      electionId: election.id,
      submitterPubkey: tx.from || '',
      votes,
      totalVotes: env.total != null ? Number(env.total) : null,
      invalidVotes: env.invalid != null ? Number(env.invalid) : null,
      refTxHash: env.ref_tx_id || null,
      blockHeight: tx.blockHeight || 0,
      chainTimestamp: createdAt ? new Date(createdAt) : new Date(),
      status: 'ok',
    });
    return { applied: true, kind: 'result_revise' };
  }

  if (env.type === 'evidence_submit') {
    const submission = await store.getSubmission(env.submission_id);
    if (!submission) return { applied: false, reason: 'unknown-submission' };
    const record = await store.upsertEvidence({
      txHash: tx.txId,
      submissionId: submission.id,
      electionId: submission.electionId,
      uploaderPubkey: tx.from || '',
      sha256: env.sha256 || '',
      ipfsCid: env.ipfs || '',
      ipfsStatus: env.ipfs ? 'pending' : 'unverified',
    });
    // Fire-and-forget IPFS verification
    if (env.ipfs && record) {
      verifyIpfs(store, record, env.ipfs, env.sha256).catch(() => {});
    }
    return { applied: true, kind: 'evidence_submit' };
  }

  if (env.type === 'dispute_open') {
    const submission = await store.getSubmission(env.submission_id);
    if (!submission) return { applied: false, reason: 'unknown-submission' };
    await store.upsertDispute({
      txHash: tx.txId,
      submissionId: submission.id,
      electionId: submission.electionId,
      filerPubkey: tx.from || '',
      reason: env.reason || '',
      status: 'open',
    });
    await store.markSubmissionDisputed(env.submission_id);
    return { applied: true, kind: 'dispute_open' };
  }

  if (env.type === 'dispute_resolve') {
    const dispute = await store.getDispute(env.dispute_id);
    if (!dispute) return { applied: false, reason: 'unknown-dispute' };
    await store.resolveDispute({
      txHash: dispute.txHash,
      resolveTxHash: tx.txId,
      resolvedBy: tx.from || '',
      resolution: env.notes || '',
      resolvedAt: createdAt ? new Date(createdAt) : new Date(),
    });
    return { applied: true, kind: 'dispute_resolve' };
  }

  return { applied: false, reason: 'unknown-type' };
}

async function verifyIpfs(store, record, ipfsUrl, expectedSha256) {
  try {
    const url = ipfsUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const resp = await fetch(url);
    if (!resp.ok) {
      await store.updateEvidenceIpfsStatus(record.txHash, 'unverified');
      return;
    }
    const buf = await resp.arrayBuffer();
    const hashBuf = await crypto.subtle.digest('SHA-256', buf);
    const hex = Array.from(new Uint8Array(hashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('');
    const status = hex === expectedSha256 ? 'verified' : 'invalid';
    await store.updateEvidenceIpfsStatus(record.txHash, status);
  } catch {
    await store.updateEvidenceIpfsStatus(record.txHash, 'unverified');
  }
}

function makePrismaStore(prisma) {
  return {
    async getOrg(txHash) {
      if (!txHash) return null;
      return prisma.organization.findUnique({ where: { txHash } }).catch(() => null);
    },
    async getOrgById(id) {
      if (!id) return null;
      return prisma.organization.findUnique({ where: { id: Number(id) } }).catch(() => null);
    },
    async getOrgByOwner(ownerPubkey) {
      if (!ownerPubkey) return null;
      return prisma.organization.findFirst({ where: { ownerPubkey } }).catch(() => null);
    },
    async upsertOrg(r) {
      await prisma.organization.upsert({
        where: { txHash: r.txHash },
        create: r,
        update: { name: r.name, description: r.description },
      }).catch(() => {});
    },
    async confirmOrgFee(orgTxHash) {
      await prisma.organization.updateMany({
        where: { txHash: orgTxHash },
        data: { feeConfirmed: true },
      }).catch(() => {});
    },
    async isOrgMember(orgId, pubkey) {
      if (!pubkey) return false;
      const m = await prisma.orgMember.findFirst({ where: { orgId: Number(orgId), memberPubkey: pubkey } }).catch(() => null);
      return !!m;
    },
    async upsertOrgMember(r) {
      await prisma.orgMember.upsert({
        where: { grantTxHash: r.grantTxHash },
        create: r,
        update: {},
      }).catch(() => {});
    },
    async getElection(txHash) {
      if (!txHash) return null;
      return prisma.election.findUnique({ where: { txHash } }).catch(() => null);
    },
    async upsertElection(r) {
      await prisma.election.upsert({
        where: { txHash: r.txHash },
        create: r,
        update: { name: r.name },
      }).catch(() => {});
    },
    async upsertCandidate(r) {
      await prisma.candidate.upsert({
        where: { txHash: r.txHash },
        create: r,
        update: { name: r.name, displayOrder: r.displayOrder },
      }).catch(() => {});
    },
    async getStation(txHash) {
      if (!txHash) return null;
      return prisma.station.findUnique({ where: { txHash } }).catch(() => null);
    },
    async upsertStation(r) {
      await prisma.station.upsert({
        where: { txHash: r.txHash },
        create: r,
        update: { name: r.name, region: r.region },
      }).catch(() => {});
    },
    async getSubmission(txHash) {
      if (!txHash) return null;
      return prisma.cachedSubmission.findUnique({ where: { txHash } }).catch(() => null);
    },
    async upsertSubmission(r) {
      if (!r.txHash || !r.stationId) return;
      const ts = r.chainTimestamp instanceof Date ? r.chainTimestamp : new Date(r.chainTimestamp || Date.now());
      await prisma.cachedSubmission.upsert({
        where: { txHash: r.txHash },
        create: { ...r, chainTimestamp: ts },
        update: { votes: r.votes, blockHeight: r.blockHeight, chainTimestamp: ts, indexedAt: new Date() },
      }).catch((e) => console.error('upsertSubmission failed:', e.message));
    },
    async markSubmissionRevised(txHash) {
      if (!txHash) return;
      await prisma.cachedSubmission.updateMany({ where: { txHash }, data: { status: 'revised' } }).catch(() => {});
    },
    async markSubmissionDisputed(txHash) {
      if (!txHash) return;
      await prisma.cachedSubmission.updateMany({ where: { txHash }, data: { status: 'disputed' } }).catch(() => {});
    },
    async upsertEvidence(r) {
      try {
        return await prisma.evidenceRecord.upsert({
          where: { txHash: r.txHash },
          create: r,
          update: { ipfsStatus: r.ipfsStatus },
        });
      } catch { return null; }
    },
    async updateEvidenceIpfsStatus(txHash, status) {
      await prisma.evidenceRecord.updateMany({ where: { txHash }, data: { ipfsStatus: status } }).catch(() => {});
    },
    async getDispute(txHash) {
      if (!txHash) return null;
      return prisma.dispute.findUnique({ where: { txHash } }).catch(() => null);
    },
    async upsertDispute(r) {
      await prisma.dispute.upsert({
        where: { txHash: r.txHash },
        create: r,
        update: {},
      }).catch(() => {});
    },
    async resolveDispute(r) {
      await prisma.dispute.updateMany({
        where: { txHash: r.txHash },
        data: { status: 'resolved', resolvedAt: r.resolvedAt, resolvedBy: r.resolvedBy, resolution: r.resolution, resolveTxHash: r.resolveTxHash },
      }).catch(() => {});
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

module.exports = { normalizeTx, applyTx, pollOnce, makePrismaStore };

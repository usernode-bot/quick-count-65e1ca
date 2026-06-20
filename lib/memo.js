// Quick Count v3 — on-chain memo envelopes.
// All memos carry {"app":"quickcount","type":"..."} as discriminator.
// Keys are deliberately short to stay within chain memo length limits.

const APP = 'quickcount';
const TYPES = [
  'org_register', 'election_create', 'candidate_add', 'station_add',
  'org_member', 'result_submit', 'result_revise',
  'evidence_submit', 'dispute_open', 'dispute_resolve',
];

function orgRegisterMemo(name, desc) {
  const m = { app: APP, type: 'org_register', name: String(name || '').slice(0, 120) };
  if (desc) m.desc = String(desc).slice(0, 280);
  return m;
}

function electionCreateMemo(orgId, name, visibility, agg) {
  return {
    app: APP, type: 'election_create',
    org_id: String(orgId),
    name: String(name || '').slice(0, 120),
    visibility: visibility || 'public',
    agg: agg || 'first_report',
  };
}

function candidateAddMemo(electionId, name, order) {
  return {
    app: APP, type: 'candidate_add',
    election_id: String(electionId),
    name: String(name || '').slice(0, 80),
    order: Number(order) || 0,
  };
}

function stationAddMemo(electionId, name, region) {
  const m = { app: APP, type: 'station_add', election_id: String(electionId), name: String(name || '').slice(0, 80) };
  if (region) m.region = String(region).slice(0, 80);
  return m;
}

function orgMemberMemo(orgId, memberPubkey) {
  return { app: APP, type: 'org_member', org_id: String(orgId), member: String(memberPubkey) };
}

function resultSubmitMemo(electionId, stationId, votes, total, invalid) {
  const m = {
    app: APP, type: 'result_submit',
    election_id: String(electionId),
    station_id: String(stationId),
    votes: {},
  };
  const src = votes && typeof votes === 'object' ? votes : {};
  for (const k of Object.keys(src)) {
    const n = Number(src[k]);
    if (Number.isFinite(n)) m.votes[String(k)] = Math.max(0, Math.round(n));
  }
  if (total != null && Number.isFinite(Number(total))) m.total = Math.max(0, Math.round(Number(total)));
  if (invalid != null && Number.isFinite(Number(invalid))) m.invalid = Math.max(0, Math.round(Number(invalid)));
  return m;
}

function resultReviseMemo(electionId, stationId, votes, refTxId, total, invalid) {
  const m = resultSubmitMemo(electionId, stationId, votes, total, invalid);
  m.type = 'result_revise';
  m.ref_tx_id = String(refTxId);
  return m;
}

function evidenceSubmitMemo(submissionId, sha256, ipfsCid) {
  const m = { app: APP, type: 'evidence_submit', submission_id: String(submissionId), sha256: String(sha256) };
  if (ipfsCid) m.ipfs = String(ipfsCid);
  return m;
}

function disputeOpenMemo(submissionId, reason) {
  return { app: APP, type: 'dispute_open', submission_id: String(submissionId), reason: String(reason || '').slice(0, 280) };
}

function disputeResolveMemo(disputeId, notes) {
  return { app: APP, type: 'dispute_resolve', dispute_id: String(disputeId), notes: String(notes || '').slice(0, 280) };
}

function encode(obj) {
  return JSON.stringify(obj);
}

function decode(str) {
  if (typeof str !== 'string' || !str) return null;
  let o;
  try { o = JSON.parse(str); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.app !== APP) return null;
  if (!TYPES.includes(o.type)) return null;
  return o;
}

module.exports = {
  APP, TYPES,
  orgRegisterMemo, electionCreateMemo, candidateAddMemo, stationAddMemo,
  orgMemberMemo, resultSubmitMemo, resultReviseMemo,
  evidenceSubmitMemo, disputeOpenMemo, disputeResolveMemo,
  encode, decode,
};

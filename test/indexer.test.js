'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { encode, decode } = require('../lib/memo');
const { normalizeTx, applyTx } = require('../lib/indexer');

function makeStore() {
  const orgs = new Map();
  const elections = new Map();
  const submissions = new Map();
  const members = new Map();
  const candidates = new Map();
  const stations = new Map();
  const evidence = new Map();
  const disputes = new Map();
  return {
    orgs, elections, submissions, members, candidates, stations, evidence, disputes,
    async getOrg(txHash) { return orgs.get(txHash) || null; },
    async getOrgById(id) { for (const o of orgs.values()) if (o.id === id) return o; return null; },
    async getOrgByOwner(ownerPubkey) { for (const o of orgs.values()) if (o.ownerPubkey === ownerPubkey) return o; return null; },
    async upsertOrg(r) { orgs.set(r.txHash, { id: orgs.size + 1, ...r }); },
    async confirmOrgFee(txHash) { const o = orgs.get(txHash); if (o) o.feeConfirmed = true; },
    async isOrgMember(orgId, pubkey) { return members.has(`${orgId}:${pubkey}`); },
    async upsertOrgMember(r) { members.set(`${r.orgId}:${r.memberPubkey}`, r); },
    async getElection(txHash) { return elections.get(txHash) || null; },
    async upsertElection(r) { elections.set(r.txHash, { id: elections.size + 1, ...r }); },
    async upsertCandidate(r) { candidates.set(r.txHash, r); },
    async getStation(txHash) { return stations.get(txHash) || null; },
    async upsertStation(r) { stations.set(r.txHash, { id: stations.size + 1, ...r }); },
    async getSubmission(txHash) { return submissions.get(txHash) || null; },
    async upsertSubmission(r) { submissions.set(r.txHash, r); },
    async markSubmissionRevised(txHash) { const s = submissions.get(txHash); if (s) s.status = 'revised'; },
    async markSubmissionDisputed(txHash) { const s = submissions.get(txHash); if (s) s.status = 'disputed'; },
    async upsertEvidence(r) { evidence.set(r.txHash, r); return r; },
    async updateEvidenceIpfsStatus(txHash, status) { const e = evidence.get(txHash); if (e) e.ipfsStatus = status; },
    async getDispute(txHash) { return disputes.get(txHash) || null; },
    async upsertDispute(r) { disputes.set(r.txHash, r); },
    async resolveDispute(r) { const d = disputes.get(r.txHash); if (d) Object.assign(d, r); },
  };
}

test('decode returns null for null memo', () => {
  assert.strictEqual(decode(null), null);
});

test('decode returns null for non-quickcount memo', () => {
  assert.strictEqual(decode(JSON.stringify({ v: 1, t: 'el', name: 'old' })), null);
  assert.strictEqual(decode(JSON.stringify({ app: 'other', type: 'org_register' })), null);
});

test('applyTx applies org_register', async () => {
  const store = makeStore();
  const memo = encode({ app: 'quickcount', type: 'org_register', name: 'Test Org' });
  const result = await applyTx(store, { txId: 'org-tx-1', memo, from: 'owner-pub', to: 'dest', amount: 0 });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.kind, 'org_register');
  assert.strictEqual(store.orgs.size, 1);
  const org = store.orgs.get('org-tx-1');
  assert.strictEqual(org.name, 'Test Org');
  assert.strictEqual(org.ownerPubkey, 'owner-pub');
  assert.strictEqual(org.status, 'pending');
});

test('applyTx applies election_create for registered org', async () => {
  const store = makeStore();
  await store.upsertOrg({ txHash: 'org-1', ownerPubkey: 'owner-pub', name: 'My Org', status: 'registered', feeConfirmed: true });
  const memo = encode({ app: 'quickcount', type: 'election_create', org_id: 'org-1', name: 'My Election', visibility: 'public', agg: 'first_report' });
  const result = await applyTx(store, { txId: 'el-tx-1', memo, from: 'owner-pub', to: 'dest', amount: 0 });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.kind, 'election_create');
  assert.strictEqual(store.elections.size, 1);
});

test('applyTx rejects election_create from wrong pubkey', async () => {
  const store = makeStore();
  await store.upsertOrg({ txHash: 'org-1', ownerPubkey: 'owner-pub', name: 'My Org', status: 'registered', feeConfirmed: true });
  const memo = encode({ app: 'quickcount', type: 'election_create', org_id: 'org-1', name: 'Hack', visibility: 'public', agg: 'first_report' });
  const result = await applyTx(store, { txId: 'el-bad', memo, from: 'not-owner', to: 'dest', amount: 0 });
  assert.strictEqual(result.applied, false);
  assert.strictEqual(result.reason, 'unauthorized');
});

test('applyTx applies result_submit', async () => {
  const store = makeStore();
  await store.upsertOrg({ txHash: 'org-1', ownerPubkey: 'owner-pub', name: 'Org', status: 'registered', feeConfirmed: true });
  await store.upsertElection({ txHash: 'el-1', orgId: 1, name: 'Election', visibility: 'public', aggregation: 'first_report', status: 'open' });
  await store.upsertStation({ txHash: 'stn-1', electionId: 1, name: 'Station 1', region: '' });
  const memo = encode({ app: 'quickcount', type: 'result_submit', election_id: 'el-1', station_id: 'stn-1', votes: { 'cand-1': 42 } });
  const result = await applyTx(store, { txId: 'sub-1', memo, from: 'reporter-pub', to: 'dest', amount: 0, blockHeight: 100 });
  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.kind, 'result_submit');
  assert.strictEqual(store.submissions.size, 1);
  assert.deepStrictEqual(store.submissions.get('sub-1').votes, { 'cand-1': 42 });
});

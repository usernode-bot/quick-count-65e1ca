'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const memo = require('../lib/memo');
const { normalizeTx, applyTx } = require('../lib/indexer');
const { latestPerStation, computeTally, reporting } = require('../lib/aggregate');

// Minimal in-memory store mirroring the new store interface (insert-if-absent
// for elections/candidates/stations, upsert by txHash for submissions).
function makeStore() {
  return {
    elections: new Map(),
    candidates: new Map(),
    stations: new Map(),
    submissions: new Map(),
    async getElection(eid) { return this.elections.get(eid) || null; },
    async putElection(r) { if (!this.elections.has(r.eid)) this.elections.set(r.eid, r); },
    async putCandidate(r) { const k = r.eid + '/' + r.cid; if (!this.candidates.has(k)) this.candidates.set(k, r); },
    async putStation(r) { const k = r.eid + '/' + r.sid; if (!this.stations.has(k)) this.stations.set(k, r); },
    async upsertSubmission(r) { this.submissions.set(r.txHash, r); },
  };
}

test('memo envelopes round-trip for all four types', () => {
  assert.deepStrictEqual(memo.decode(memo.encode(memo.electionMemo('E'))), { v: 1, t: 'el', name: 'E' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.candidateMemo('e1', 2, 'Red'))), { v: 1, t: 'cand', eid: 'e1', cid: 2, name: 'Red' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.stationMemo('e1', 3, 'A'))), { v: 1, t: 'stn', eid: 'e1', sid: 3, name: 'A' });
  const r = memo.decode(memo.encode(memo.resultMemo('e1', 3, { 1: 10, 2: 5 }, 16, 1)));
  assert.deepStrictEqual(r, { v: 1, t: 'res', eid: 'e1', sid: 3, votes: { 1: 10, 2: 5 }, tot: 16, inv: 1 });
});

test('decode rejects malformed / wrong-version / unknown-type memos', () => {
  assert.strictEqual(memo.decode('not json'), null);
  assert.strictEqual(memo.decode(JSON.stringify({ v: 2, t: 'el' })), null);
  assert.strictEqual(memo.decode(JSON.stringify({ v: 1, t: 'nope' })), null);
  assert.strictEqual(memo.decode(null), null);
});

test('indexer applies election + children and is idempotent on replay', async () => {
  const store = makeStore();
  const elTx = { txId: 'EL1', from: 'utA', to: 'utA', memo: memo.encode(memo.electionMemo('Town Vote')), createdAt: '2026-06-20T10:00:00.000Z' };
  assert.strictEqual((await applyTx(store, elTx)).applied, true);
  const candTx = { txId: 'C1', from: 'utA', to: 'utA', memo: memo.encode(memo.candidateMemo('EL1', 1, 'Red')), createdAt: '2026-06-20T10:01:00.000Z' };
  assert.strictEqual((await applyTx(store, candTx)).applied, true);

  // Replay both — no duplicates.
  await applyTx(store, elTx);
  await applyTx(store, candTx);
  assert.strictEqual(store.elections.size, 1);
  assert.strictEqual(store.candidates.size, 1);
});

test('structural tx from a non-creator pubkey is ignored; results accepted from anyone', async () => {
  const store = makeStore();
  await applyTx(store, { txId: 'EL1', from: 'utCreator', to: 'utCreator', memo: memo.encode(memo.electionMemo('E')), createdAt: '2026-06-20T10:00:00.000Z' });

  // Stranger tries to inject a candidate → rejected.
  const bad = await applyTx(store, { txId: 'X', from: 'utStranger', to: 'utCreator', memo: memo.encode(memo.candidateMemo('EL1', 9, 'Fake')), createdAt: '2026-06-20T10:02:00.000Z' });
  assert.strictEqual(bad.applied, false);
  assert.strictEqual(bad.reason, 'unauthorized');
  assert.strictEqual(store.candidates.size, 0);

  // Anyone may submit a result.
  const ok = await applyTx(store, { txId: 'R1', from: 'utAgent', to: 'utCreator', memo: memo.encode(memo.resultMemo('EL1', 1, { 1: 5 })), createdAt: '2026-06-20T10:03:00.000Z' });
  assert.strictEqual(ok.applied, true);
  assert.strictEqual(store.submissions.size, 1);
});

test('normalizeTx maps field-name variants', () => {
  const t = normalizeTx({ hash: ' H ', sender: 'utA', to: 'utB', memo: 'm', created_at: '2026-06-20T10:00:00Z' });
  assert.strictEqual(t.txId, 'H');
  assert.strictEqual(t.from, 'utA');
  assert.strictEqual(t.to, 'utB');
  assert.strictEqual(t.createdAt, '2026-06-20T10:00:00.000Z');
});

test('latest-per-station picks the most recent submission', () => {
  const results = [
    { sid: 1, tx_id: 'a', votes: { 1: 40, 2: 60 }, created_at: '2026-06-20T10:00:00.000Z' },
    { sid: 1, tx_id: 'b', votes: { 1: 52, 2: 71 }, created_at: '2026-06-20T10:20:00.000Z' },
    { sid: 2, tx_id: 'c', votes: { 1: 80, 2: 35 }, created_at: '2026-06-20T10:10:00.000Z' },
  ];
  const latest = latestPerStation(results);
  assert.strictEqual(latest.get(1).tx_id, 'b'); // later one wins
  assert.strictEqual(latest.get(2).tx_id, 'c');

  const candidates = [{ cid: 1 }, { cid: 2 }];
  const tally = computeTally(candidates, latest);
  assert.deepStrictEqual(tally, { 1: 52 + 80, 2: 71 + 35 });

  const prog = reporting([{ sid: 1 }, { sid: 2 }, { sid: 3 }], latest);
  assert.deepStrictEqual(prog, { reported: 2, total: 3 });
});

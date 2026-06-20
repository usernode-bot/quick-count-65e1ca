'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const memo = require('../lib/memo');
const { QuickCountIndexer, normalizeTx } = require('../lib/indexer');
const agg = require('../lib/aggregate');

const CFG = { treasury: 'TREASURY', orgFee: 100, adminAddrs: ['ADMIN'] };
let _t = Date.parse('2026-06-19T08:00:00.000Z');
function mk(txId, from, to, amount, env) {
  _t += 60000;
  return { txId, from, to, amount, memo: memo.encode(env), createdAt: new Date(_t).toISOString() };
}

// ── Memo ──────────────────────────────────────────────────────────────────
test('memo envelopes round-trip for all types', () => {
  assert.deepStrictEqual(memo.decode(memo.encode(memo.orgMemo('Org', 'J'))), { app: 'quickcount', v: 1, t: 'org', name: 'Org', jur: 'J' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.electionMemo('E'))), { app: 'quickcount', v: 1, t: 'el', name: 'E' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.candidateMemo('e1', 2, 'Red'))), { app: 'quickcount', v: 1, t: 'cand', eid: 'e1', cid: 2, name: 'Red' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.stationMemo('e1', 3, 'A', 'N'))), { app: 'quickcount', v: 1, t: 'stn', eid: 'e1', sid: 3, name: 'A', label: 'N' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.observerMemo('e1', 'obs', 2))), { app: 'quickcount', v: 1, t: 'obs', eid: 'e1', addr: 'obs', sid: 2 });
  const h = 'a'.repeat(64);
  assert.deepStrictEqual(memo.decode(memo.encode(memo.resultMemo('e1', 3, { 1: 10, 2: 5 }, 16, 1, h))), { app: 'quickcount', v: 1, t: 'res', eid: 'e1', sid: 3, votes: { 1: 10, 2: 5 }, tot: 16, inv: 1, ev: h });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.disputeMemo('e1', 'tx9', 'why'))), { app: 'quickcount', v: 1, t: 'disp', eid: 'e1', target: 'tx9', reason: 'why' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.resolveMemo('e1', 'd1', 'uphold'))), { app: 'quickcount', v: 1, t: 'dres', eid: 'e1', disp: 'd1', verdict: 'uphold' });
  assert.deepStrictEqual(memo.decode(memo.encode(memo.adminMemo('waive', 'O'))), { app: 'quickcount', v: 1, t: 'adm', act: 'waive', org: 'O' });
});

test('decode rejects malformed / wrong app / wrong version', () => {
  assert.strictEqual(memo.decode('nope'), null);
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'other', v: 1, t: 'el', name: 'x' })), null);
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 2, t: 'el' })), null);
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'zzz' })), null);
  assert.strictEqual(memo.decode(JSON.stringify({ app: 'quickcount', v: 1, t: 'cand', eid: 'e', cid: 0 })), null);
});

// ── Fee gating + visibility ─────────────────────────────────────────────────
test('org is active only when the fee is paid to the treasury', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild([
    mk('o1', 'orgPaid', 'TREASURY', 100, memo.orgMemo('Paid')),
    mk('o2', 'orgShort', 'TREASURY', 50, memo.orgMemo('Underpaid')),
    mk('o3', 'orgWrong', 'someoneElse', 100, memo.orgMemo('WrongDest')),
  ]);
  assert.strictEqual(ix.orgs.get('orgPaid').active, true);
  assert.strictEqual(ix.orgs.get('orgShort').active, false);
  assert.strictEqual(ix.orgs.get('orgWrong').active, false);
});

test('elections from inactive orgs are hidden from the public but visible to owner/admin', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild([
    mk('o1', 'org', 'TREASURY', 0, memo.orgMemo('Pending')),
    mk('el1', 'org', 'org', 0, memo.electionMemo('Hidden')),
  ]);
  assert.strictEqual(ix.visibleElections({}).length, 0);
  assert.strictEqual(ix.visibleElections({ viewer: 'org' }).length, 1);
  assert.strictEqual(ix.visibleElections({ admin: true }).length, 1);
});

test('admin can waive the fee to activate an org', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild([
    mk('o1', 'org', 'TREASURY', 0, memo.orgMemo('Pending')),
    mk('a1', 'ADMIN', 'ADMIN', 0, memo.adminMemo('waive', 'org')),
  ]);
  assert.strictEqual(ix.orgs.get('org').active, true);
  assert.strictEqual(ix.orgs.get('org').waived, true);
});

// ── Authorization ───────────────────────────────────────────────────────────
test('structural changes require the organizing wallet; results require an observer', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild([
    mk('o1', 'org', 'TREASURY', 100, memo.orgMemo('Org')),
    mk('el1', 'org', 'org', 0, memo.electionMemo('E')),
    mk('c1', 'org', 'org', 0, memo.candidateMemo('el1', 1, 'Red')),
    mk('s1', 'org', 'org', 0, memo.stationMemo('el1', 1, 'A')),
    // Stranger tries to add a candidate → ignored.
    mk('cBad', 'stranger', 'org', 0, memo.candidateMemo('el1', 9, 'Fake')),
    // Authorize observer, scoped to station 1.
    mk('ob1', 'org', 'org', 0, memo.observerMemo('el1', 'obs', 1)),
    // Result from a non-observer → ignored.
    mk('rBad', 'stranger', 'org', 0, memo.resultMemo('el1', 1, { 1: 5 })),
    // Result from observer but wrong station → ignored.
    mk('rWrong', 'obs', 'org', 0, memo.resultMemo('el1', 2, { 1: 5 })),
    // Valid result.
    mk('rOk', 'obs', 'org', 0, memo.resultMemo('el1', 1, { 1: 7 })),
  ]);
  assert.strictEqual(ix.candidates.get('el1').size, 1);
  const results = ix.results.get('el1');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].txId, 'rOk');
});

test('replaying the same log is idempotent', () => {
  const txs = [
    mk('o1', 'org', 'TREASURY', 100, memo.orgMemo('Org')),
    mk('el1', 'org', 'org', 0, memo.electionMemo('E')),
    mk('c1', 'org', 'org', 0, memo.candidateMemo('el1', 1, 'Red')),
  ];
  const a = new QuickCountIndexer(CFG); a.rebuild(txs);
  const b = new QuickCountIndexer(CFG); b.rebuild(txs.concat(txs)); // duplicates
  assert.strictEqual(a.elections.size, b.elections.size);
  assert.strictEqual(b.candidates.get('el1').size, 1);
});

// ── Disputes ────────────────────────────────────────────────────────────────
test('upheld dispute invalidates the target result; rejected clears the flag', () => {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild([
    mk('o1', 'org', 'TREASURY', 100, memo.orgMemo('Org')),
    mk('el1', 'org', 'org', 0, memo.electionMemo('E')),
    mk('s1', 'org', 'org', 0, memo.stationMemo('el1', 1, 'A')),
    mk('s2', 'org', 'org', 0, memo.stationMemo('el1', 2, 'B')),
    mk('ob1', 'org', 'org', 0, memo.observerMemo('el1', 'obs')),
    mk('r1', 'obs', 'org', 0, memo.resultMemo('el1', 1, { 1: 10 })),
    mk('r2', 'obs', 'org', 0, memo.resultMemo('el1', 2, { 1: 20 })),
    mk('d1', 'obs', 'org', 0, memo.disputeMemo('el1', 'r1', 'bad')),
    mk('dr1', 'org', 'org', 0, memo.resolveMemo('el1', 'd1', 'uphold')),
    mk('d2', 'org', 'org', 0, memo.disputeMemo('el1', 'r2', 'check')),
    mk('dr2', 'org', 'org', 0, memo.resolveMemo('el1', 'd2', 'reject')),
  ]);
  assert.strictEqual(ix.resultByTx.get('r1').invalid, true);
  assert.strictEqual(ix.resultByTx.get('r2').invalid, false);
  assert.strictEqual(ix.resultByTx.get('r2').disputed, false);
});

// ── Aggregation ─────────────────────────────────────────────────────────────
test('five aggregation methods over a multi-observer fixture', () => {
  const candidates = [{ cid: 1 }, { cid: 2 }];
  const results = [
    { sid: 1, txId: 'a', observer: 'o1', votes: { 1: 40, 2: 60 }, createdAt: '2026-06-20T10:00:00.000Z', invalid: false, disputed: false },
    { sid: 1, txId: 'b', observer: 'o2', votes: { 1: 52, 2: 71 }, createdAt: '2026-06-20T10:20:00.000Z', invalid: false, disputed: false },
    { sid: 2, txId: 'c', observer: 'o1', votes: { 1: 80, 2: 35 }, createdAt: '2026-06-20T10:10:00.000Z', invalid: false, disputed: false },
    { sid: 2, txId: 'd', observer: 'o3', votes: { 1: 90, 2: 35 }, createdAt: '2026-06-20T10:15:00.000Z', invalid: false, disputed: false },
  ];
  assert.strictEqual(agg.perStation('latest', results).get(1).votes[1], 52);
  assert.strictEqual(agg.perStation('first', results).get(1).votes[1], 40);
  // Station 2: candidate 2 is 35 in both → consensus/median 35; candidate 1 differs (80,90) → median 85.
  assert.strictEqual(agg.perStation('median', results).get(2).votes[1], 85);
  assert.strictEqual(agg.perStation('consensus', results).get(2).votes[2], 35);

  const latest = agg.perStation('latest', results);
  assert.deepStrictEqual(agg.computeTally(candidates, latest), { 1: 52 + 90, 2: 71 + 35 });
  assert.deepStrictEqual(agg.reporting([{ sid: 1 }, { sid: 2 }, { sid: 3 }], latest), { reported: 2, total: 3 });
});

test('verified-only excludes invalidated results', () => {
  const results = [
    { sid: 1, txId: 'a', votes: { 1: 10 }, createdAt: '2026-06-20T10:00:00.000Z', invalid: true, disputed: false },
    { sid: 2, txId: 'b', votes: { 1: 20 }, createdAt: '2026-06-20T10:00:00.000Z', invalid: false, disputed: false },
  ];
  const v = agg.perStation('verified', results);
  assert.strictEqual(v.has(1), false);
  assert.strictEqual(v.get(2).votes[1], 20);
});

test('marginAndReview flags stations whose observers disagree', () => {
  const candidates = [{ cid: 1 }, { cid: 2 }];
  const results = [
    { sid: 1, txId: 'a', votes: { 1: 10, 2: 90 }, createdAt: '2026-06-20T10:00:00.000Z', invalid: false, disputed: false },
    { sid: 1, txId: 'b', votes: { 1: 80, 2: 20 }, createdAt: '2026-06-20T10:10:00.000Z', invalid: false, disputed: false },
  ];
  const map = agg.perStation('latest', results);
  const tally = agg.computeTally(candidates, map);
  const mr = agg.marginAndReview(candidates, results, map, tally);
  assert.strictEqual(mr.stationFlags[1].needsReview, true);
  assert.strictEqual(mr.needsReview, true);
});

// ── normalizeTx ─────────────────────────────────────────────────────────────
test('normalizeTx maps field-name variants and amount', () => {
  const t = normalizeTx({ hash: ' H ', sender: 'A', recipient: 'B', amount: '100', memo: 'm', created_at: '2026-06-20T10:00:00Z' });
  assert.strictEqual(t.txId, 'H');
  assert.strictEqual(t.from, 'A');
  assert.strictEqual(t.to, 'B');
  assert.strictEqual(t.amount, 100);
  assert.strictEqual(t.createdAt, '2026-06-20T10:00:00.000Z');
});

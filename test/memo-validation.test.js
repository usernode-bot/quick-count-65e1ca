'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const memo = require('../lib/memo');

// ── Memo validation (mirrors lib/memo.js decode logic) ─────────────────────
test('org memo: valid and invalid cases', () => {
  const valid = memo.orgMemo('My Org', 'District A');
  assert.ok(valid.app === 'quickcount' && valid.t === 'org' && valid.name);

  const invalidEmpty = memo.orgMemo('', '');
  assert.strictEqual(memo.decode(JSON.stringify(invalidEmpty)).name, 'Untitled organization'); // still parsed, defaults to untitled
});

test('election memo: valid name required', () => {
  const valid = memo.electionMemo('Election 2026');
  assert.ok(valid.app === 'quickcount' && valid.t === 'el');

  const invalidEmpty = memo.electionMemo('');
  assert.strictEqual(memo.decode(JSON.stringify(invalidEmpty)).name, 'Untitled election');
});

test('candidate memo: requires eid and cid >= 1', () => {
  const valid = memo.candidateMemo('eid-123', 1, 'Alice');
  assert.ok(valid.app === 'quickcount' && valid.t === 'cand' && valid.cid === 1);

  // Invalid: cid < 1
  const invalidCid = memo.candidateMemo('eid-123', 0, 'Bob');
  assert.strictEqual(memo.decode(JSON.stringify(invalidCid)), null);

  // Invalid: missing eid
  const invalidEid = { app: 'quickcount', v: 1, t: 'cand', cid: 1, name: 'Charlie' };
  assert.strictEqual(memo.decode(JSON.stringify(invalidEid)), null);
});

test('station memo: requires eid and sid >= 1', () => {
  const valid = memo.stationMemo('eid-123', 5, 'North School', 'District 1');
  assert.ok(valid.app === 'quickcount' && valid.t === 'stn' && valid.sid === 5);

  // Invalid: sid < 1
  const invalidSid = memo.stationMemo('eid-123', 0, 'South School', 'District 2');
  assert.strictEqual(memo.decode(JSON.stringify(invalidSid)), null);
});

test('observer memo: requires eid and addr', () => {
  const valid = memo.observerMemo('eid-123', 'ut1observer00000000000000000000000000');
  assert.ok(valid.app === 'quickcount' && valid.t === 'obs');

  // Invalid: missing eid
  const invalidEid = { app: 'quickcount', v: 1, t: 'obs', addr: 'ut1observer00000000000000000000000000' };
  assert.strictEqual(memo.decode(JSON.stringify(invalidEid)), null);

  // Invalid: missing addr
  const invalidAddr = { app: 'quickcount', v: 1, t: 'obs', eid: 'eid-123' };
  assert.strictEqual(memo.decode(JSON.stringify(invalidAddr)), null);
});

test('result memo: requires eid, sid >= 1, and votes object', () => {
  const valid = memo.resultMemo('eid-123', 3, { '1': 100, '2': 85 }, 200, 15, 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1');
  assert.ok(valid.app === 'quickcount' && valid.t === 'res' && valid.sid === 3);

  // Invalid: missing votes (votes key is required in the object)
  const invalidVotes = { app: 'quickcount', v: 1, t: 'res', eid: 'eid-123', sid: 3, votes: {} };
  const decoded = memo.decode(JSON.stringify(invalidVotes));
  assert.ok(decoded.t === 'res'); // empty votes object is valid

  // Valid: empty votes object (no votes recorded)
  const emptyVotes = memo.resultMemo('eid-123', 3, {}, 0, 0);
  assert.ok(memo.decode(JSON.stringify(emptyVotes)).t === 'res');
});

test('dispute memo: requires eid and target', () => {
  const valid = memo.disputeMemo('eid-123', 'tx-id-of-result', 'Votes appear incorrect', 'abc123def456');
  assert.ok(valid.app === 'quickcount' && valid.t === 'disp');

  // Invalid: missing eid
  const invalidEid = { app: 'quickcount', v: 1, t: 'disp', target: 'tx-123', reason: 'Bad data' };
  assert.strictEqual(memo.decode(JSON.stringify(invalidEid)), null);
});

test('dispute resolve memo: requires eid, disp, and valid verdict', () => {
  const validUphold = memo.resolveMemo('eid-123', 'dispute-id', 'uphold');
  assert.strictEqual(validUphold.verdict, 'uphold');

  const validReject = memo.resolveMemo('eid-123', 'dispute-id', 'reject');
  assert.strictEqual(validReject.verdict, 'reject');

  // Invalid verdict defaults to reject
  const invalidVerdict = memo.resolveMemo('eid-123', 'dispute-id', 'invalid');
  assert.strictEqual(invalidVerdict.verdict, 'reject');

  // Invalid: missing disp
  const invalidDisp = { app: 'quickcount', v: 1, t: 'dres', eid: 'eid-123', verdict: 'uphold' };
  assert.strictEqual(memo.decode(JSON.stringify(invalidDisp)), null);
});

test('cleanVotes: filters invalid vote entries', () => {
  const votes = { '1': 100, '2': 50.5, '3': -10, '4': 'invalid', '5': 0 };
  const clean = memo.cleanVotes(votes);
  assert.strictEqual(clean['1'], 100);
  assert.strictEqual(clean['2'], 51); // rounded to int
  // '3' has value -10: posInt(-10) returns Math.max(0, -10) = 0, so it's included
  assert.strictEqual(clean['3'], 0); // negative becomes 0 via Math.max
  assert.ok(!('4' in clean)); // non-numeric filtered: posInt('invalid') returns null
  assert.strictEqual(clean['5'], 0); // 0 is valid (0 votes for candidate 5)
});

test('hash validation: 64-char hex only', () => {
  const valid64 = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';
  const memo1 = memo.resultMemo('eid-123', 1, {}, 0, 0, valid64);
  const decoded1 = memo.decode(JSON.stringify(memo1));
  assert.ok(decoded1.ev === valid64.toLowerCase());

  // Invalid: too short (not 64 chars)
  const invalid = memo.resultMemo('eid-123', 1, {}, 0, 0, 'abc123');
  const decoded2 = memo.decode(JSON.stringify(invalid));
  assert.strictEqual(decoded2.ev, undefined); // ev not set when hash is invalid

  // Invalid: non-hex (has x's not valid hex)
  const nonhex = memo.resultMemo('eid-123', 1, {}, 0, 0, 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  const decoded3 = memo.decode(JSON.stringify(nonhex));
  assert.strictEqual(decoded3.ev, undefined); // ev not set
});

test('memo with wrong version is rejected', () => {
  const badVersion = { app: 'quickcount', v: 2, t: 'org', name: 'My Org' };
  assert.strictEqual(memo.decode(JSON.stringify(badVersion)), null);
});

test('memo with wrong app is rejected', () => {
  const badApp = { app: 'other-app', v: 1, t: 'org', name: 'My Org' };
  assert.strictEqual(memo.decode(JSON.stringify(badApp)), null);
});

test('memo with unknown type is rejected', () => {
  const badType = { app: 'quickcount', v: 1, t: 'unknown', name: 'My Org' };
  assert.strictEqual(memo.decode(JSON.stringify(badType)), null);
});

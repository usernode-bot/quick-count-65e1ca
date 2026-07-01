'use strict';

// Tests for the pure local-first vote-count queue helpers (public/vote-queue.js).
// The DOM / timer / fetch / tx wiring in index.html is not unit-tested (no
// jsdom harness in this repo) — these cover the entry shape, dedup key,
// (de)serialization, exhaustion/backoff and fetch-error classification that
// the wiring depends on, mirroring test/election-queue.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const VQ = require('../public/vote-queue.js');

test('makeEntry: worktally shape and defaults', () => {
  const e = VQ.makeEntry({ eid: 'e1', sid: 3, votes: { evan: 5, salah: 2 } });
  assert.strictEqual(e.kind, 'worktally');
  assert.strictEqual(e.eid, 'e1');
  assert.strictEqual(e.sid, 3);
  assert.deepStrictEqual(e.votes, { evan: 5, salah: 2 });
  assert.strictEqual(e.tot, null);
  assert.strictEqual(e.inv, null);
  assert.strictEqual(e.evHash, null);
  assert.strictEqual(e.orgAddr, null);
  assert.strictEqual(e.attempts, 0);
  assert.strictEqual(e.offline, false);
  assert.strictEqual(e.lastError, null);
  assert.strictEqual(e.demo, false);
  assert.strictEqual(typeof e.id, 'string');
  assert.ok(e.id.length > 0);
});

test('makeEntry: result kind carries tot/inv/evHash/orgAddr', () => {
  const e = VQ.makeEntry({
    kind: 'result', eid: 'e1', sid: 2, votes: { 1: 10, 2: 20 },
    tot: '30', inv: '0', evHash: 'abc123', orgAddr: 'org-addr',
  });
  assert.strictEqual(e.kind, 'result');
  assert.strictEqual(e.tot, '30');
  assert.strictEqual(e.inv, '0');
  assert.strictEqual(e.evHash, 'abc123');
  assert.strictEqual(e.orgAddr, 'org-addr');
});

test('makeEntry: unknown kind collapses to worktally', () => {
  const e = VQ.makeEntry({ kind: 'bogus', eid: 'e1', sid: 1 });
  assert.strictEqual(e.kind, 'worktally');
});

test('makeEntry: votes is copied, not referenced', () => {
  const votes = { evan: 1 };
  const e = VQ.makeEntry({ eid: 'e1', sid: 1, votes: votes });
  votes.evan = 999;
  assert.strictEqual(e.votes.evan, 1);
});

test('makeEntry: empty/blank tot and inv collapse to null', () => {
  const e = VQ.makeEntry({ kind: 'result', eid: 'e1', sid: 1, tot: '', inv: '' });
  assert.strictEqual(e.tot, null);
  assert.strictEqual(e.inv, null);
});

test('makeEntry: seed overrides id/attempts/offline/demo/createdAt', () => {
  const e = VQ.makeEntry({ eid: 'e1', sid: 1 },
    { id: 'staging-demo', attempts: 2, offline: true, demo: true, createdAt: '2026-01-01T00:00:00.000Z' });
  assert.strictEqual(e.id, 'staging-demo');
  assert.strictEqual(e.attempts, 2);
  assert.strictEqual(e.offline, true);
  assert.strictEqual(e.demo, true);
  assert.strictEqual(e.createdAt, '2026-01-01T00:00:00.000Z');
});

test('entryKey: identity is kind:eid:sid, distinguishing kinds and stations', () => {
  const a = VQ.makeEntry({ kind: 'worktally', eid: 'e1', sid: 3 });
  const b = VQ.makeEntry({ kind: 'result', eid: 'e1', sid: 3 });
  const c = VQ.makeEntry({ kind: 'worktally', eid: 'e1', sid: 4 });
  assert.strictEqual(VQ.entryKey(a), 'worktally:e1:3');
  assert.notStrictEqual(VQ.entryKey(a), VQ.entryKey(b));
  assert.notStrictEqual(VQ.entryKey(a), VQ.entryKey(c));
});

test('isWellFormed: requires id, non-empty eid, and integer sid', () => {
  assert.strictEqual(VQ.isWellFormed(VQ.makeEntry({ eid: 'e1', sid: 1 })), true);
  assert.strictEqual(VQ.isWellFormed(null), false);
  assert.strictEqual(VQ.isWellFormed({ id: 'x', eid: '', sid: 1 }), false);
  assert.strictEqual(VQ.isWellFormed({ id: 'x', eid: 'e1', sid: 1.5 }), false);
  assert.strictEqual(VQ.isWellFormed({ id: '', eid: 'e1', sid: 1 }), false);
});

test('serialize/deserialize: round-trips a well-formed queue', () => {
  const q = [
    VQ.makeEntry({ eid: 'e1', sid: 1, votes: { evan: 3 } }),
    VQ.makeEntry({ kind: 'result', eid: 'e1', sid: 2, votes: { 1: 9 }, tot: '9', inv: '0', evHash: 'h', orgAddr: 'org' }),
  ];
  const back = VQ.deserialize(VQ.serialize(q));
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].kind, 'worktally');
  assert.deepStrictEqual(back[0].votes, { evan: 3 });
  assert.strictEqual(back[1].kind, 'result');
  assert.strictEqual(back[1].tot, '9');
  assert.strictEqual(back[1].orgAddr, 'org');
});

test('serialize: drops malformed entries before persisting', () => {
  const bad = { id: '', eid: 'e1', sid: 1 };
  const good = VQ.makeEntry({ eid: 'e1', sid: 1 });
  const str = VQ.serialize([bad, good]);
  const parsed = JSON.parse(str);
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].id, good.id);
});

test('deserialize: drops malformed entries (missing id/eid/sid)', () => {
  const raw = JSON.stringify([
    { id: 'ok', eid: 'e1', sid: 1 },
    { id: 'no-eid', eid: '', sid: 1 },
    { id: 'no-sid', eid: 'e1' },
    null,
    'garbage',
  ]);
  const back = VQ.deserialize(raw);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].id, 'ok');
});

test('deserialize: never throws on bad JSON', () => {
  assert.deepStrictEqual(VQ.deserialize('{not json'), []);
  assert.deepStrictEqual(VQ.deserialize(''), []);
  assert.deepStrictEqual(VQ.deserialize(null), []);
  assert.deepStrictEqual(VQ.deserialize('{"a":1}'), []); // object, not array
});

test('deserialize: preserves offline/attempts/lastError/demo', () => {
  const raw = JSON.stringify([{ id: 'i', eid: 'e1', sid: 1, attempts: 2, offline: true, lastError: 'boom', demo: true }]);
  const back = VQ.deserialize(raw);
  assert.strictEqual(back[0].attempts, 2);
  assert.strictEqual(back[0].offline, true);
  assert.strictEqual(back[0].lastError, 'boom');
  assert.strictEqual(back[0].demo, true);
});

test('MAX_ATTEMPTS: caps failed retries at 3', () => {
  assert.strictEqual(VQ.MAX_ATTEMPTS, 3);
});

test('isExhausted: true only at/after the attempt cap or when parked offline', () => {
  assert.strictEqual(VQ.isExhausted(null), false);
  assert.strictEqual(VQ.isExhausted({ attempts: 0 }), false);
  assert.strictEqual(VQ.isExhausted({ attempts: 2 }), false);
  assert.strictEqual(VQ.isExhausted({ attempts: 3 }), true);
  assert.strictEqual(VQ.isExhausted({ attempts: 7 }), true);
  assert.strictEqual(VQ.isExhausted({ attempts: 0, offline: true }), true);
});

test('allExhausted: every entry must be exhausted; empty queue is not', () => {
  assert.strictEqual(VQ.allExhausted([]), false);
  assert.strictEqual(VQ.allExhausted([{ attempts: 3 }]), true);
  assert.strictEqual(VQ.allExhausted([{ attempts: 3 }, { attempts: 1 }]), false);
  assert.strictEqual(VQ.allExhausted([{ attempts: 3 }, { offline: true }]), true);
});

test('nextBackoff: non-negative, grows with attempt, capped at MAX_BACKOFF_MS', () => {
  const a = VQ.nextBackoff(0);
  const b = VQ.nextBackoff(3);
  const c = VQ.nextBackoff(50);
  assert.ok(a >= 0);
  assert.ok(b >= a);
  assert.ok(c <= VQ.MAX_BACKOFF_MS);
  assert.ok(VQ.nextBackoff(-5) >= 0); // negative attempt clamps to 0
});

test('classifyFetchStatus: 4xx is terminal', () => {
  assert.strictEqual(VQ.classifyFetchStatus(400), 'terminal');
  assert.strictEqual(VQ.classifyFetchStatus(403), 'terminal');
  assert.strictEqual(VQ.classifyFetchStatus(404), 'terminal');
  assert.strictEqual(VQ.classifyFetchStatus(499), 'terminal');
});

test('classifyFetchStatus: 5xx, non-4xx, and missing status are transient', () => {
  assert.strictEqual(VQ.classifyFetchStatus(500), 'transient');
  assert.strictEqual(VQ.classifyFetchStatus(503), 'transient');
  assert.strictEqual(VQ.classifyFetchStatus(200), 'transient');
  assert.strictEqual(VQ.classifyFetchStatus(undefined), 'transient');
  assert.strictEqual(VQ.classifyFetchStatus(null), 'transient');
});

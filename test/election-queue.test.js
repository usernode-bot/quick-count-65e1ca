'use strict';

// Tests for the pure local-first election-queue helpers (public/election-queue.js).
// The DOM / timer / fetch wiring in index.html is not unit-tested (no jsdom
// harness in this repo) — these cover the entry shape, (de)serialization,
// confirmation predicate, backoff, and pill-label formatting that the wiring
// depends on, mirroring test/inline-entry.test.js.

const { test } = require('node:test');
const assert = require('node:assert');
const ELQ = require('../public/election-queue.js');

test('makeEntry: shape and defaults', () => {
  const e = ELQ.makeEntry({ name: '  Mayoral 2026 ', candidates: [' Ada', '', 'Bo ', '  '] });
  assert.strictEqual(e.name, 'Mayoral 2026'); // trimmed
  assert.deepStrictEqual(e.candidates, ['Ada', 'Bo']); // trimmed + blanks dropped
  assert.strictEqual(e.txId, null);
  assert.strictEqual(e.eid, null);
  assert.strictEqual(e.attempts, 0);
  assert.strictEqual(e.status, 'queued');
  assert.strictEqual(e.lastError, null);
  assert.deepStrictEqual(e.sent, []);
  assert.strictEqual(e.demo, false);
  assert.strictEqual(typeof e.id, 'string');
  assert.ok(e.id.length > 0);
});

test('makeEntry: seed overrides id/status/demo', () => {
  const e = ELQ.makeEntry({ name: 'X', candidates: ['a'] },
    { id: 'staging-demo-pending', status: 'queued', demo: true });
  assert.strictEqual(e.id, 'staging-demo-pending');
  assert.strictEqual(e.demo, true);
});

test('makeEntry: non-array candidates collapse to empty', () => {
  const e = ELQ.makeEntry({ name: 'X', candidates: null });
  assert.deepStrictEqual(e.candidates, []);
});

test('markBroadcast: sets eid === txId and flips status', () => {
  const e = ELQ.makeEntry({ name: 'X', candidates: ['a'] });
  ELQ.markBroadcast(e, 'tx-abc');
  assert.strictEqual(e.txId, 'tx-abc');
  assert.strictEqual(e.eid, 'tx-abc');
  assert.strictEqual(e.status, 'confirming');
});

test('markBroadcast: no txId leaves ids null but advances status', () => {
  const e = ELQ.makeEntry({ name: 'X', candidates: ['a'] });
  ELQ.markBroadcast(e, null);
  assert.strictEqual(e.eid, null);
  assert.strictEqual(e.status, 'confirming');
});

test('isConfirmed: false when eid is null', () => {
  const e = ELQ.makeEntry({ name: 'X', candidates: ['a'] });
  assert.strictEqual(ELQ.isConfirmed(e, [{ eid: 'whatever' }]), false);
});

test('isConfirmed: false when eid not present in list', () => {
  const e = ELQ.markBroadcast(ELQ.makeEntry({ name: 'X', candidates: ['a'] }), 'tx-1');
  assert.strictEqual(ELQ.isConfirmed(e, [{ eid: 'tx-2' }, { eid: 'tx-3' }]), false);
});

test('isConfirmed: true when a matching eid is in the list (tolerant of extra fields)', () => {
  const e = ELQ.markBroadcast(ELQ.makeEntry({ name: 'X', candidates: ['a'] }), 'tx-1');
  const list = [{ eid: 'tx-9', name: 'Other' }, { eid: 'tx-1', name: 'X', stationCount: 3 }];
  assert.strictEqual(ELQ.isConfirmed(e, list), true);
});

test('isConfirmed: false on a non-array elections list', () => {
  const e = ELQ.markBroadcast(ELQ.makeEntry({ name: 'X', candidates: ['a'] }), 'tx-1');
  assert.strictEqual(ELQ.isConfirmed(e, null), false);
  assert.strictEqual(ELQ.isConfirmed(e, undefined), false);
});

test('nextBackoff: non-negative, monotonic-ish, and capped at MAX_BACKOFF_MS', () => {
  const a = ELQ.nextBackoff(0);
  const b = ELQ.nextBackoff(3);
  const c = ELQ.nextBackoff(50);
  assert.ok(a >= 0);
  assert.ok(b >= a); // later attempts wait at least as long (within jitter, base grows)
  assert.ok(c <= ELQ.MAX_BACKOFF_MS);
  assert.ok(ELQ.nextBackoff(-5) >= 0); // negative attempt clamps to 0
});

test('serialize/deserialize: round-trips a well-formed queue', () => {
  const q = [
    ELQ.markBroadcast(ELQ.makeEntry({ name: 'A', candidates: ['x'] }), 'tx-A'),
    ELQ.makeEntry({ name: 'B', candidates: [] }),
  ];
  const back = ELQ.deserialize(ELQ.serialize(q));
  assert.strictEqual(back.length, 2);
  assert.strictEqual(back[0].name, 'A');
  assert.strictEqual(back[0].eid, 'tx-A');
  assert.strictEqual(back[0].status, 'confirming');
  assert.strictEqual(back[1].name, 'B');
  assert.strictEqual(back[1].status, 'queued');
});

test('deserialize: drops malformed entries (missing id/name)', () => {
  const raw = JSON.stringify([
    { id: 'ok', name: 'Good' },
    { id: 'no-name' },
    { name: 'no-id' },
    null,
    'garbage',
    { id: '', name: 'empty-id' },
  ]);
  const back = ELQ.deserialize(raw);
  assert.strictEqual(back.length, 1);
  assert.strictEqual(back[0].id, 'ok');
});

test('deserialize: never throws on bad JSON', () => {
  assert.deepStrictEqual(ELQ.deserialize('{not json'), []);
  assert.deepStrictEqual(ELQ.deserialize(''), []);
  assert.deepStrictEqual(ELQ.deserialize(null), []);
  assert.deepStrictEqual(ELQ.deserialize('{"a":1}'), []); // object, not array
});

test('deserialize: backfills eid from txId and preserves sent/demo', () => {
  const raw = JSON.stringify([{ id: 'i', name: 'N', txId: 'tx-5', sent: ['tx-5'], demo: true }]);
  const back = ELQ.deserialize(raw);
  assert.strictEqual(back[0].eid, 'tx-5');
  assert.deepStrictEqual(back[0].sent, ['tx-5']);
  assert.strictEqual(back[0].demo, true);
});

test('summaryLabel: singular vs counted', () => {
  const t = (k) => ({
    queue_saved_locally: 'Saved locally — retrying…',
    queue_saved_locally_n: 'Saved locally — retrying… ({n})',
  }[k] || k);
  assert.strictEqual(ELQ.summaryLabel([{ id: '1', name: 'a' }], t), 'Saved locally — retrying…');
  assert.strictEqual(
    ELQ.summaryLabel([{ id: '1', name: 'a' }, { id: '2', name: 'b' }, { id: '3', name: 'c' }], t),
    'Saved locally — retrying… (3)'
  );
  assert.strictEqual(ELQ.summaryLabel([], t), 'Saved locally — retrying…');
});

test('summaryLabel: falls back to "(n)" when template lacks {n}', () => {
  const t = (k) => (k === 'queue_saved_locally' ? 'Retrying' : k);
  assert.strictEqual(
    ELQ.summaryLabel([{ id: '1', name: 'a' }, { id: '2', name: 'b' }], t),
    'Retrying (2)'
  );
});

test('MAX_ATTEMPTS: caps failed retries at 3', () => {
  assert.strictEqual(ELQ.MAX_ATTEMPTS, 3);
});

test('isExhausted: true only at/after the attempt cap or when parked offline', () => {
  assert.strictEqual(ELQ.isExhausted(null), false);
  assert.strictEqual(ELQ.isExhausted({ attempts: 0 }), false);
  assert.strictEqual(ELQ.isExhausted({ attempts: 1 }), false);
  assert.strictEqual(ELQ.isExhausted({ attempts: 2 }), false);
  assert.strictEqual(ELQ.isExhausted({ attempts: 3 }), true); // hit MAX_ATTEMPTS
  assert.strictEqual(ELQ.isExhausted({ attempts: 7 }), true);
  assert.strictEqual(ELQ.isExhausted({ attempts: 0, offline: true }), true); // explicit park
});

test('allExhausted: every entry must be exhausted; empty queue is not', () => {
  assert.strictEqual(ELQ.allExhausted([]), false);
  assert.strictEqual(ELQ.allExhausted([{ attempts: 3 }]), true);
  assert.strictEqual(ELQ.allExhausted([{ attempts: 3 }, { attempts: 1 }]), false); // one still retrying
  assert.strictEqual(ELQ.allExhausted([{ attempts: 3 }, { offline: true }]), true);
});

test('summaryLabel: offline label once every entry is exhausted', () => {
  const t = (k) => ({
    queue_saved_locally: 'Saved locally — retrying…',
    queue_saved_locally_n: 'Saved locally — retrying… ({n})',
    queue_saved_offline: 'Saved Locally (Offline)',
  }[k] || k);
  // All exhausted → static offline label, regardless of count.
  assert.strictEqual(ELQ.summaryLabel([{ id: '1', name: 'a', attempts: 3 }], t), 'Saved Locally (Offline)');
  assert.strictEqual(
    ELQ.summaryLabel([{ id: '1', name: 'a', offline: true }, { id: '2', name: 'b', attempts: 3 }], t),
    'Saved Locally (Offline)'
  );
  // Mixed: at least one still retrying → keep the retrying (counted) label.
  assert.strictEqual(
    ELQ.summaryLabel([{ id: '1', name: 'a', attempts: 3 }, { id: '2', name: 'b', attempts: 1 }], t),
    'Saved locally — retrying… (2)'
  );
});

test('makeEntry / deserialize: carry the offline flag', () => {
  const e = ELQ.makeEntry({ name: 'X', candidates: ['a'] },
    { id: 'staging-demo-offline', demo: true, offline: true, attempts: 3 });
  assert.strictEqual(e.offline, true);
  assert.strictEqual(e.attempts, 3);
  const round = ELQ.deserialize(ELQ.serialize([e]));
  assert.strictEqual(round[0].offline, true);
  assert.strictEqual(round[0].attempts, 3);
});

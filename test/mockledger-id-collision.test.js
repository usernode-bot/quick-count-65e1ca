'use strict';

// Regression test for the "nothing appears in the list after creating, and it
// doesn't survive a refresh" bug affecting BOTH organisations and elections.
//
// The mock ledger is process-local and ephemeral, but the ids it mints
// (mocktx_NNNNNN) are PERSISTED to `chain_txs` and replayed into the indexer's
// `seen` set on boot — and, in staging, the production chain_txs rows are COPIED
// into every preview container. After a restart/redeploy the in-memory counter
// resets to 0, so the next submission regenerated mocktx_000001, mocktx_000002,
// … — ids the indexer had already seen, which ingestRaw then dropped as
// duplicates. The freshly created org/election never reached the indexer.
//
// noteId() keeps the counter ahead of every id already known (loaded from the DB
// on boot, or ingested at runtime), so a post-restart submission always mints a
// fresh, non-colliding id.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

const mock = require('../lib/mockledger');

beforeEach(() => mock.reset());

test('noteId advances the counter so a later auto-minted id never collides', () => {
  mock.noteId('mocktx_000005');
  const next = mock.append({ from: 'ut1a', to: 'ut1t', amount: 100, memo: 'm' });
  assert.strictEqual(next.txId, 'mocktx_000006', 'counter resumes past the noted id');
});

test('post-restart submissions do not reuse ids persisted in a prior session', () => {
  // Session 1: two creations are minted and (in production) persisted.
  const a = mock.append({ from: 'ut1a', to: 'ut1t', amount: 100, memo: 'm1' });
  const b = mock.append({ from: 'ut1b', to: 'ut1t', amount: 100, memo: 'm2' });
  assert.deepStrictEqual([a.txId, b.txId], ['mocktx_000001', 'mocktx_000002']);

  // Restart/redeploy: the module's in-memory ledger is gone (reset), but the ids
  // it minted live on in chain_txs (and the indexer's `seen` set). loadFromDb
  // replays them and calls noteId() for each.
  mock.reset();
  const seen = new Set([a.txId, b.txId]);
  seen.forEach((id) => mock.noteId(id));

  // A brand-new creation after the restart must NOT regenerate a seen id.
  const c = mock.append({ from: 'ut1c', to: 'ut1t', amount: 100, memo: 'm3' });
  assert.strictEqual(c.txId, 'mocktx_000003');
  assert.ok(!seen.has(c.txId), 'new id does not collide with a persisted id');
});

test('append with an explicit mocktx id advances the counter past it', () => {
  // A seeded / backdated row carrying its own mocktx id must also push the
  // counter forward, so a subsequent auto-minted id clears it.
  mock.append({ txId: 'mocktx_000010', from: 'ut1a', to: 'ut1t', amount: 0, memo: 'seed' });
  const next = mock.append({ from: 'ut1b', to: 'ut1t', amount: 0, memo: 'm' });
  assert.strictEqual(next.txId, 'mocktx_000011');
});

test('noteId ignores non-mocktx ids (real chain / demo ids leave the counter alone)', () => {
  mock.noteId('demo_org_a');
  mock.noteId('usertx_registration_1');
  mock.noteId(null);
  const next = mock.append({ from: 'ut1a', to: 'ut1t', amount: 0, memo: 'm' });
  assert.strictEqual(next.txId, 'mocktx_000001', 'counter untouched by foreign id shapes');
});

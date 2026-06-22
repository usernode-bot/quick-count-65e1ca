'use strict';

// Unit tests for lib/confirm.js — the pure matching core of the client
// confirmTx() poll (mirrored inline in public/index.html + dashboard.html).

const { test } = require('node:test');
const assert = require('node:assert');
const { matchTxInList, txIdOf, txArray } = require('../lib/confirm');

test('matchTxInList finds an id across field-name variants', () => {
  assert.ok(matchTxInList([{ tx_hash: 'abc' }], 'abc'));
  assert.ok(matchTxInList([{ id: 'x' }, { txId: 'y' }], 'y'));
  assert.ok(matchTxInList({ transactions: [{ hash: 'h1' }] }, 'h1'));
  assert.ok(!matchTxInList([{ tx_hash: 'abc' }], 'zzz'), 'absent id does not match');
  assert.ok(!matchTxInList([], 'abc'), 'empty list does not match');
  assert.ok(!matchTxInList([{ tx_hash: 'abc' }], null), 'null id never matches');
});

test('matchTxInList is a boolean — a late/duplicate arrival is harmless', () => {
  // The same id appearing twice still matches exactly once (boolean), so a tx
  // that lands after a confirmation timeout cannot be "double counted".
  assert.strictEqual(matchTxInList([{ id: 'dup' }, { tx_id: 'dup' }], 'dup'), true);
});

test('txArray normalizes the loosely-typed response envelope shapes', () => {
  assert.deepStrictEqual(txArray([1, 2]), [1, 2]);
  assert.deepStrictEqual(txArray({ transactions: [1] }), [1]);
  assert.deepStrictEqual(txArray({ txs: [2] }), [2]);
  assert.deepStrictEqual(txArray({ results: [3] }), [3]);
  assert.deepStrictEqual(txArray(null), []);
});

test('txIdOf prefers the first present variant and trims whitespace', () => {
  assert.strictEqual(txIdOf({ id: ' a ' }), 'a');
  assert.strictEqual(txIdOf({ tx_hash: 'h' }), 'h');
  assert.strictEqual(txIdOf({}), null);
  assert.strictEqual(txIdOf(null), null);
});

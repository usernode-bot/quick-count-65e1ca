'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const memo = require('../lib/memo');
const { unlockMemo, isUnlockMemo, verifyPayment } = require('../lib/unlock');

const RECIPIENT = 'ut1recipient00000000000000000000000000';
const PAYER = 'ut1payer000000000000000000000000000000';

function goodTx(over = {}) {
  return Object.assign({
    txId: 'TX1',
    from: PAYER,
    to: RECIPIENT,
    amount: 10,
    memo: unlockMemo(),
  }, over);
}

test('unlock memo round-trips and is recognized', () => {
  assert.strictEqual(isUnlockMemo(unlockMemo()), true);
  assert.strictEqual(isUnlockMemo('not json'), false);
  assert.strictEqual(isUnlockMemo(JSON.stringify({ v: 2, t: 'unlock' })), false);
  assert.strictEqual(isUnlockMemo(JSON.stringify({ v: 1, t: 'el' })), false);
  assert.strictEqual(isUnlockMemo(null), false);
});

test('the unlock memo is ignored by the results indexer (memo.decode rejects it)', () => {
  // Guarantees an unlock payment never pollutes the election read model.
  assert.strictEqual(memo.decode(unlockMemo()), null);
});

test('verifyPayment accepts a correct payment', () => {
  const r = verifyPayment(goodTx(), { recipient: RECIPIENT, price: 10, sender: PAYER });
  assert.deepStrictEqual(r, { ok: true });
});

test('verifyPayment accepts an overpayment (amount > price)', () => {
  const r = verifyPayment(goodTx({ amount: 25 }), { recipient: RECIPIENT, price: 10, sender: PAYER });
  assert.strictEqual(r.ok, true);
});

test('verifyPayment rejects wrong recipient', () => {
  const r = verifyPayment(goodTx({ to: 'ut1someoneelse' }), { recipient: RECIPIENT, price: 10, sender: PAYER });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong-recipient');
});

test('verifyPayment rejects wrong sender (cannot claim someone else\'s payment)', () => {
  const r = verifyPayment(goodTx({ from: 'ut1attacker' }), { recipient: RECIPIENT, price: 10, sender: PAYER });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong-sender');
});

test('verifyPayment rejects insufficient amount', () => {
  const r = verifyPayment(goodTx({ amount: 9 }), { recipient: RECIPIENT, price: 10, sender: PAYER });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'insufficient-amount');
});

test('verifyPayment rejects a non-unlock memo', () => {
  const r = verifyPayment(goodTx({ memo: memo.encode(memo.electionMemo('E')) }), { recipient: RECIPIENT, price: 10, sender: PAYER });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'bad-memo');
});

test('verifyPayment rejects a missing transaction', () => {
  const r = verifyPayment({}, { recipient: RECIPIENT, price: 10, sender: PAYER });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'tx-not-found');
});

test('verifyPayment rejects when no recipient is configured', () => {
  const r = verifyPayment(goodTx(), { recipient: '', price: 10, sender: PAYER });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no-recipient-configured');
});

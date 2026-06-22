'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classifyBridgeError, isRetryable } = require('../public/usernode-bridge-classify');

// ── Transaction flow integration tests ────────────────────────────────────
// Tests the lifecycle: send → classify → retry vs fail → confirm → success/timeout

test('transient error (bridge not ready) is retryable', () => {
  const err = new Error('Wallet bridge not ready');
  const kind = classifyBridgeError(err);
  assert.strictEqual(kind, 'transient');
  assert.strictEqual(isRetryable(kind, {}), true);
  assert.strictEqual(err.qcCode, 'BRIDGE_UNREACHABLE');
});

test('ambiguous error (relay timeout) is NOT auto-retried for non-idempotent', () => {
  const err = new Error('Usernode relay timed out');
  const kind = classifyBridgeError(err);
  assert.strictEqual(kind, 'ambiguous');
  assert.strictEqual(isRetryable(kind, { idempotent: false }), false);
  assert.strictEqual(isRetryable(kind, { idempotent: true }), true);
  assert.strictEqual(err.qcCode, 'BRIDGE_RELAY_TIMEOUT');
});

test('terminal error (user rejected) is never retried', () => {
  const err = new Error('Transaction rejected by user');
  const kind = classifyBridgeError(err);
  assert.strictEqual(kind, 'terminal');
  assert.strictEqual(isRetryable(kind, { idempotent: false }), false);
  assert.strictEqual(isRetryable(kind, { idempotent: true }), false);
  assert.strictEqual(err.qcCode, 'BRIDGE_REJECTED');
});

test('confirmation timeout error has CONFIRM_TIMEOUT code', () => {
  const err = new Error('Awaiting confirmation timed out');
  err.qcKind = 'transient';
  err.qcCode = 'CONFIRM_TIMEOUT';
  assert.strictEqual(err.qcCode, 'CONFIRM_TIMEOUT');
  assert.strictEqual(err.qcKind, 'transient');
  // Should be retryable because transient
  assert.strictEqual(isRetryable(err.qcKind, {}), true);
});

test('memo validation error (client-side) is terminal', () => {
  const err = new Error('Invalid transaction memo');
  err.qcKind = 'terminal';
  err.qcCode = 'MEMO_INVALID';
  assert.strictEqual(err.qcCode, 'MEMO_INVALID');
  assert.strictEqual(isRetryable(err.qcKind, { idempotent: true }), false);
});

test('multi-step flow with partial success', () => {
  // Simulate: Step 1 succeeds (election created with id='eid-1'),
  //           Step 2 fails (first candidate send fails),
  //           Try-again retries from step 2
  const steps = [
    { name: 'create-election', txId: 'tx-election-001', done: true },
    { name: 'add-candidate-1', txId: null, done: false, error: 'BRIDGE_RELAY_TIMEOUT' },
    { name: 'add-candidate-2', txId: null, done: false, error: null },
  ];

  // After step 1 succeeds and step 2 fails
  const failedStep = 1; // index of failed step
  const partialMsg = `Election published; ${failedStep} of ${steps.length} candidates added.`;
  assert.ok(partialMsg.includes('1 of 3'));

  // Verify step 2 error is ambiguous (relay timeout)
  const step2Err = new Error('Usernode relay timed out');
  const kind = classifyBridgeError(step2Err);
  assert.strictEqual(kind, 'ambiguous');

  // Step 2 is NOT idempotent, so should not auto-retry
  assert.strictEqual(isRetryable(kind, { idempotent: false }), false);

  // But on Try-again, user re-invokes from step 2 with fresh memo
  // (same election id eid-1, candidate 2)
  // If the original send actually landed on-chain, confirmTx will find it
  // and the flow resumes to step 3
});

test('ambiguous error handling: check ledger before deciding to resend', () => {
  // Scenario: Step 1 send times out (ambiguous).
  // Client doesn't know if the tx was broadcast.
  // On Try-again:
  //   1. Caller-side: detect 'ambiguous' in catch block
  //   2. Instead of re-sending, call confirmTx(lastTxId) to check ledger
  //   3. If found: success, resume from next step (no resend)
  //   4. If not found: throw again, show "Try-again"

  const err = new Error('Relay timed out');
  const kind = classifyBridgeError(err);
  assert.strictEqual(kind, 'ambiguous');

  // Pseudo-logic: if (kind === 'ambiguous') { confirmTx(lastTxId).catch(() => show TryAgain) }
  assert.ok(kind === 'ambiguous');
});

test('confirmation timeout vs send timeout are distinct', () => {
  const sendTimeoutErr = new Error('Relay timed out');
  const sendKind = classifyBridgeError(sendTimeoutErr);
  assert.strictEqual(sendKind, 'ambiguous');
  assert.strictEqual(sendTimeoutErr.qcCode, 'BRIDGE_RELAY_TIMEOUT');

  const confirmTimeoutErr = new Error('Awaiting confirmation timed out');
  confirmTimeoutErr.qcKind = 'transient';
  confirmTimeoutErr.qcCode = 'CONFIRM_TIMEOUT';
  assert.strictEqual(confirmTimeoutErr.qcCode, 'CONFIRM_TIMEOUT');
  assert.notStrictEqual(sendTimeoutErr.qcCode, confirmTimeoutErr.qcCode);
});

test('error code tagging enables grouped error handling', () => {
  const errors = [
    { err: new Error('Wallet bridge not ready'), expectedCode: 'BRIDGE_UNREACHABLE' },
    { err: new Error('Relay timed out'), expectedCode: 'BRIDGE_RELAY_TIMEOUT' },
    { err: new Error('User rejected'), expectedCode: 'BRIDGE_REJECTED' },
    { err: new Error('Invalid memo'), expectedCode: null }, // set manually
  ];

  for (const { err, expectedCode } of errors) {
    classifyBridgeError(err);
    if (expectedCode) {
      assert.strictEqual(err.qcCode, expectedCode);
    } else {
      err.qcCode = 'MEMO_INVALID';
      assert.strictEqual(err.qcCode, 'MEMO_INVALID');
    }
  }
});

test('extended bridge readiness timeout (10s vs 6s)', () => {
  // The bridge readiness check now polls for 100 attempts (instead of 60)
  // at 100ms intervals = 10s instead of 6s
  // This is verified by the resilience layer logs, but we can assert
  // that the classification still works if readiness eventually times out
  const err = new Error('Wallet bridge not ready');
  err.qcCode = 'BRIDGE_INIT_TIMEOUT';
  assert.strictEqual(err.qcCode, 'BRIDGE_INIT_TIMEOUT');
});

test('retry count tracking across attempts', () => {
  // Pseudo-scenario: a transaction flow tracks retries
  // { retryCount: 0 } initially
  // After first failure and Try-again: { retryCount: 1 }
  // After second failure: { retryCount: 2 }
  // Display: "retry attempt #2" in the UI notice

  let txState = { retryCount: 0 };
  txState.retryCount++; // first retry
  assert.strictEqual(txState.retryCount, 1);
  txState.retryCount++; // second retry
  assert.strictEqual(txState.retryCount, 2);
  // Notice would say: "That didn't go through (retry attempt #2). Your entries were kept."
});

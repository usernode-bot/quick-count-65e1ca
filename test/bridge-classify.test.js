'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// The classifier ships as a browser asset (loaded via <script> in the HTML
// shell) but is authored as a UMD module so this Node test can require it.
const {
  classifyBridgeError,
  isRetryable,
  isRecoverable,
  backoffDelay,
  BACKOFF_MS,
} = require('../public/usernode-bridge-classify');

// ── classifyBridgeError ──────────────────────────────────────────────────────
test('terminal: user-rejected / insufficient-funds / bad input are terminal', () => {
  assert.equal(classifyBridgeError(new Error('Transaction rejected by user')), 'terminal');
  assert.equal(classifyBridgeError('User declined the request'), 'terminal');
  assert.equal(classifyBridgeError(new Error('Insufficient funds for transfer')), 'terminal');
  assert.equal(classifyBridgeError(new Error('Invalid address: ut1xyz')), 'terminal');
});

test('ambiguous: relay timeouts may have submitted — classified ambiguous', () => {
  assert.equal(classifyBridgeError(new Error('Usernode relay timed out')), 'ambiguous');
  assert.equal(classifyBridgeError('Request timed out'), 'ambiguous');
  assert.equal(classifyBridgeError(new Error('Gateway timeout')), 'ambiguous');
});

test('transient: pre-submission hiccups are transient', () => {
  assert.equal(classifyBridgeError(new Error('Wallet bridge not ready')), 'transient');
  assert.equal(classifyBridgeError('window.sendTransaction is not a function'), 'transient');
  assert.equal(classifyBridgeError(new Error('Failed to fetch')), 'transient');
});

test('unknown: unrecognised text falls through to unknown (the safe branch)', () => {
  assert.equal(classifyBridgeError(new Error('something weird happened')), 'unknown');
  assert.equal(classifyBridgeError(null), 'unknown');
  assert.equal(classifyBridgeError(''), 'unknown');
});

test('ambiguous takes precedence over transient when both could match', () => {
  // A timeout message must never be treated as a safe-to-resend transient.
  assert.equal(classifyBridgeError(new Error('network error: request timed out')), 'ambiguous');
});

// ── isRetryable (classification + caller intent) ─────────────────────────────
test('terminal is never auto-retried, idempotent or not', () => {
  assert.equal(isRetryable('terminal', { idempotent: false }), false);
  assert.equal(isRetryable('terminal', { idempotent: true }), false);
});

test('transient is always auto-retried', () => {
  assert.equal(isRetryable('transient', {}), true);
  assert.equal(isRetryable('transient', { idempotent: false }), true);
});

test('ambiguous auto-retries ONLY when the caller opted into idempotent', () => {
  assert.equal(isRetryable('ambiguous', { idempotent: false }), false);
  assert.equal(isRetryable('ambiguous', { idempotent: true }), true);
});

test('unknown auto-retries ONLY when idempotent (default-safe)', () => {
  assert.equal(isRetryable('unknown', {}), false);
  assert.equal(isRetryable('unknown', { idempotent: true }), true);
});

// ── isRecoverable (controls Try-again affordance) ────────────────────────────
test('only terminal is non-recoverable', () => {
  assert.equal(isRecoverable('terminal'), false);
  assert.equal(isRecoverable('ambiguous'), true);
  assert.equal(isRecoverable('transient'), true);
  assert.equal(isRecoverable('unknown'), true);
});

// ── backoffDelay ─────────────────────────────────────────────────────────────
test('backoff grows then caps at the last step, with bounded jitter', () => {
  // rand=0.5 → exactly the base; rand=0/1 → ±25% bounds.
  assert.equal(backoffDelay(0, () => 0.5), BACKOFF_MS[0]);
  assert.equal(backoffDelay(1, () => 0.5), BACKOFF_MS[1]);
  assert.equal(backoffDelay(2, () => 0.5), BACKOFF_MS[2]);
  assert.equal(backoffDelay(99, () => 0.5), BACKOFF_MS[BACKOFF_MS.length - 1]); // capped
  const lo = backoffDelay(0, () => 0), hi = backoffDelay(0, () => 1);
  assert.ok(lo < BACKOFF_MS[0] && hi > BACKOFF_MS[0]);
  assert.ok(lo >= Math.round(BACKOFF_MS[0] * 0.75) && hi <= Math.round(BACKOFF_MS[0] * 1.25));
});

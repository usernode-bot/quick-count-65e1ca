// Quick Count — pure bridge-error classifier (NO DOM, requirable in Node).
//
// The hosted Usernode bridge (getNodeAddress / sendTransaction) can fail in
// three meaningfully different ways. This module is the single source of truth
// for telling them apart, so the resilience layer (public/usernode-resilience.js)
// and the test suite (test/bridge-classify.test.js) agree on the rules.
//
//   terminal  — the action genuinely failed and repeating it won't help, or
//               would be wrong (user rejected, insufficient funds, bad input).
//   ambiguous — a relay/timeout error where the transaction MAY already have
//               been submitted on-chain. Never auto-resend a non-idempotent
//               call here, or we risk a duplicate election / double fee.
//   transient — a pre-submission hiccup (bridge not ready yet, network blip).
//               Safe to auto-retry.
//   unknown   — message we don't recognise. Treated as the SAFE branch: only
//               auto-retry when the caller swears the op is idempotent.
//
// Match lists are substring matches against the lowercased error text. They are
// deliberately broad and central: if the platform changes its wording, an
// unrecognised message degrades to "unknown" → manual Try again, never to a
// silent double-submit.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QCBridgeClassify = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TERMINAL = [
    'reject', 'declined', 'denied', 'cancel', 'user closed',
    'insufficient', 'not enough', 'invalid address', 'invalid recipient',
    'unauthorized', 'forbidden', 'malformed',
  ];
  // Checked BEFORE transient: a relay timeout may have landed on-chain.
  var AMBIGUOUS = [
    'relay timed out', 'usernode relay', 'timed out', 'timeout',
    'no response from relay', 'awaiting confirmation', 'still pending',
    'gateway timeout', 'request timed out',
  ];
  var TRANSIENT = [
    'not ready', 'bridge unavailable', 'bridge not ready', 'not connected',
    'is not a function', 'undefined is not', 'failed to fetch',
    'networkerror', 'network error', 'load failed', 'connection refused',
  ];

  function messageOf(err) {
    if (err == null) return '';
    if (typeof err === 'string') return err;
    if (err.message) return String(err.message);
    try { return String(err); } catch (_) { return ''; }
  }
  function anyMatch(text, list) {
    for (var i = 0; i < list.length; i++) { if (text.indexOf(list[i]) !== -1) return true; }
    return false;
  }

  function classifyBridgeError(err) {
    var text = messageOf(err).toLowerCase();
    if (!text) return 'unknown';
    if (anyMatch(text, TERMINAL)) {
      if (err && typeof err === 'object' && !err.qcCode) { try { err.qcCode = 'BRIDGE_REJECTED'; } catch (_) {} }
      return 'terminal';
    }
    if (anyMatch(text, AMBIGUOUS)) {
      if (err && typeof err === 'object' && !err.qcCode) { try { err.qcCode = 'BRIDGE_RELAY_TIMEOUT'; } catch (_) {} }
      return 'ambiguous';
    }
    if (anyMatch(text, TRANSIENT)) {
      if (err && typeof err === 'object' && !err.qcCode) { try { err.qcCode = 'BRIDGE_UNREACHABLE'; } catch (_) {} }
      return 'transient';
    }
    if (err && typeof err === 'object' && !err.qcCode) { try { err.qcCode = 'BRIDGE_UNKNOWN'; } catch (_) {} }
    return 'unknown';
  }

  // Whether an automatic retry is safe given the classification + caller intent.
  // Default-safe: ambiguous/unknown only auto-retry for idempotent (latest-wins
  // or read-only) calls; everything risky falls through to a manual Try again.
  function isRetryable(kind, opts) {
    opts = opts || {};
    if (kind === 'terminal') return false;
    if (kind === 'transient') return true;
    if (kind === 'ambiguous') return opts.idempotent === true;
    return opts.idempotent === true; // unknown
  }

  // Whether the failure should surface a Try-again affordance (recoverable) vs.
  // a plain error toast (terminal — repeating won't help).
  function isRecoverable(kind) { return kind !== 'terminal'; }

  var BACKOFF_MS = [500, 1000, 2000];
  // attempt is 0-based: the pause BEFORE retry number attempt+1.
  function backoffDelay(attempt, rand) {
    var base = BACKOFF_MS[Math.min(Math.max(attempt, 0), BACKOFF_MS.length - 1)];
    var r = typeof rand === 'function' ? rand() : 0.5;
    return Math.round(base * (0.75 + r * 0.5)); // ±25% jitter
  }

  return {
    classifyBridgeError: classifyBridgeError,
    isRetryable: isRetryable,
    isRecoverable: isRecoverable,
    backoffDelay: backoffDelay,
    MAX_ATTEMPTS: 3,
    BACKOFF_MS: BACKOFF_MS,
    _fragments: { TERMINAL: TERMINAL, AMBIGUOUS: AMBIGUOUS, TRANSIENT: TRANSIENT },
  };
});

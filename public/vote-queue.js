// Quick Count — pure helpers for the local-first vote-count save queue.
//
// Loaded in the browser as `window.QCVoteQueue` (served statically from
// /public) and `require()`d directly by the node --test unit tests. The DOM /
// timer / fetch / tx wiring lives in index.html; the entry shape,
// (de)serialization, exhaustion/backoff and fetch-error classification are
// kept here — pure and side-effect-free — mirroring /public/election-queue.js.
//
// An entry models ONE queued, per-station vote-count save that hasn't been
// confirmed by the server yet. Two kinds share this queue:
//   'worktally' — the off-chain quick working-tally PUT (saveWorkTally)
//   'result'    — the official on-chain QC.res observer submission
// Both are latest-wins writes for a given (kind, eid, sid), so a fresh save
// for the same station supersedes any entry already queued for it — callers
// should replace rather than append (see `entryKey`).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QCVoteQueue = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_BACKOFF_MS = 30000;
  // Hard cap on failed persistence attempts, mirroring ELQ's cap. After this
  // many failures the entry is parked "offline" and the auto-retry loop stops
  // driving it. A regained connection (the `online` event) or a reload re-arms it.
  var MAX_ATTEMPTS = 3;

  var _seq = 0;
  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (_) { /* fall through */ }
    _seq += 1;
    return 'vq-' + _seq + '-' + (typeof Date !== 'undefined' ? Date.now() : 0);
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (_) { return ''; }
  }

  // Build a fresh queue entry. `input.kind` is 'worktally' (default) or
  // 'result'. `input.votes` is copied (never referenced) so later mutation of
  // the caller's object can't leak into the queued entry. An optional `seed`
  // overrides id/attempts/offline/createdAt (used to resume a persisted entry).
  function makeEntry(input, seed) {
    input = input || {};
    seed = seed || {};
    return {
      id: seed.id || uuid(),
      kind: input.kind === 'result' ? 'result' : 'worktally',
      eid: String(input.eid == null ? '' : input.eid),
      sid: Number(input.sid),
      votes: (input.votes && typeof input.votes === 'object') ? Object.assign({}, input.votes) : {},
      // 'result'-only fields; unused (null) for 'worktally'.
      tot: input.tot == null || input.tot === '' ? null : input.tot,
      inv: input.inv == null || input.inv === '' ? null : input.inv,
      evHash: input.evHash || null,
      orgAddr: input.orgAddr || null,
      attempts: typeof seed.attempts === 'number' && seed.attempts >= 0 ? seed.attempts : 0,
      // Parked after MAX_ATTEMPTS failures: the driver skips it and the row
      // settles to a static "Saved Locally (Offline)" badge.
      offline: !!seed.offline,
      lastError: null,
      // Staging-only display seed: shows the badge but is never driven/sent.
      demo: !!seed.demo,
      createdAt: seed.createdAt || nowIso(),
    };
  }

  // Identity key for de-duplication: a fresh save for the same election +
  // station + kind supersedes an older queued one (latest-wins), so callers
  // enqueue by replacing any existing entry with the same key rather than
  // appending a second one.
  function entryKey(e) {
    return (e && e.kind) + ':' + (e && e.eid) + ':' + (e && e.sid);
  }

  function isWellFormed(e) {
    return !!(e && typeof e.id === 'string' && e.id &&
              typeof e.eid === 'string' && e.eid &&
              Number.isInteger(e.sid));
  }

  // Serialize the queue for localStorage. Only well-formed entries survive.
  function serialize(queue) {
    var list = Array.isArray(queue) ? queue : [];
    return JSON.stringify(list.filter(isWellFormed));
  }

  // Parse a persisted queue, dropping anything missing the minimum identity
  // (id + eid + sid). Never throws — returns [] on malformed JSON.
  function deserialize(str) {
    var parsed;
    try { parsed = JSON.parse(str || '[]'); } catch (_) { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWellFormed).map(function (e) {
      return {
        id: e.id,
        kind: e.kind === 'result' ? 'result' : 'worktally',
        eid: e.eid,
        sid: e.sid,
        votes: (e.votes && typeof e.votes === 'object') ? Object.assign({}, e.votes) : {},
        tot: e.tot == null ? null : e.tot,
        inv: e.inv == null ? null : e.inv,
        evHash: e.evHash || null,
        orgAddr: e.orgAddr || null,
        attempts: typeof e.attempts === 'number' && e.attempts >= 0 ? e.attempts : 0,
        offline: !!e.offline,
        lastError: typeof e.lastError === 'string' ? e.lastError : null,
        demo: !!e.demo,
        createdAt: e.createdAt || '',
      };
    });
  }

  // An entry has exhausted its retries when it hit the attempt cap or was
  // explicitly parked offline. The driver stops retrying it once this is true.
  function isExhausted(entry) {
    if (!entry) return false;
    if (entry.offline === true) return true;
    return typeof entry.attempts === 'number' && entry.attempts >= MAX_ATTEMPTS;
  }

  // True when the queue is non-empty and EVERY entry has given up.
  function allExhausted(queue) {
    var list = Array.isArray(queue) ? queue : [];
    if (!list.length) return false;
    for (var i = 0; i < list.length; i++) { if (!isExhausted(list[i])) return false; }
    return true;
  }

  // Backoff for the Nth retry (0-based). Prefers the shared bridge-classify
  // jittered backoff when present; always capped at MAX_BACKOFF_MS.
  function nextBackoff(attempt) {
    var n = attempt < 0 ? 0 : attempt;
    var base;
    try {
      if (typeof root !== 'undefined' && root && root.QCBridgeClassify &&
          typeof root.QCBridgeClassify.backoffDelay === 'function') {
        base = root.QCBridgeClassify.backoffDelay(n, Math.random);
      }
    } catch (_) { /* fall through */ }
    if (typeof base !== 'number' || !isFinite(base)) {
      base = 800 * Math.pow(2, Math.min(n, 6)); // 800,1600,3200,… capped below
    }
    return Math.min(MAX_BACKOFF_MS, Math.max(0, Math.round(base)));
  }

  // Classify a failed fetch for the working-tally save path. A response that
  // reached the server with a 4xx status (bad input, not authorized) is
  // terminal — retrying won't fix it. No response at all (network failure /
  // offline) or a 5xx is transient and worth auto-retrying.
  function classifyFetchStatus(status) {
    if (typeof status === 'number' && status >= 400 && status < 500) return 'terminal';
    return 'transient';
  }

  return {
    MAX_BACKOFF_MS: MAX_BACKOFF_MS,
    MAX_ATTEMPTS: MAX_ATTEMPTS,
    makeEntry: makeEntry,
    entryKey: entryKey,
    isWellFormed: isWellFormed,
    serialize: serialize,
    deserialize: deserialize,
    isExhausted: isExhausted,
    allExhausted: allExhausted,
    nextBackoff: nextBackoff,
    classifyFetchStatus: classifyFetchStatus,
  };
});

// Quick Count — pure helpers for the local-first election-creation queue.
//
// Loaded in the browser as `window.QCElectionQueue` (served statically from
// /public) and `require()`d directly by the node --test unit tests. The DOM /
// timer / fetch wiring lives in index.html; the entry shape, (de)serialization,
// confirmation predicate and backoff are kept here — pure and side-effect-free —
// so they can be unit-tested without a browser, mirroring /public/inline-entry.js.
//
// An entry models one "+ New election" creation that is being persisted
// resiliently. `eid === txId` for an election (the indexer derives the election
// id from the create-transaction's txId — see lib/indexer.js applyElection), so
// once the create broadcast is accepted we know the eid and can confirm the
// write by looking for that eid in /__quickcount/state's elections[] list.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QCElectionQueue = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MAX_BACKOFF_MS = 30000;

  // Generate a client-side unique id without depending on Date.now()/Math.random
  // call-sites being mockable: crypto.randomUUID() in the browser, falling back
  // to a time+counter string under node test (no crypto.randomUUID needed there
  // because tests pass their own ids or don't assert on the value).
  var _seq = 0;
  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (_) { /* fall through */ }
    _seq += 1;
    return 'elq-' + _seq + '-' + Math.floor((typeof Date !== 'undefined' ? Date.now() : 0));
  }

  function nowIso() {
    try { return new Date().toISOString(); } catch (_) { return ''; }
  }

  // Build a fresh queue entry from the typed form values. `candidates` is
  // normalized to an array of non-empty trimmed strings. An optional `seed`
  // overrides id/createdAt/status (used by the staging demo seed).
  function makeEntry(input, seed) {
    input = input || {};
    seed = seed || {};
    var cands = Array.isArray(input.candidates) ? input.candidates : [];
    cands = cands.map(function (c) { return String(c == null ? '' : c).trim(); })
                 .filter(function (c) { return c.length > 0; });
    return {
      id: seed.id || uuid(),
      name: String(input.name == null ? '' : input.name).trim(),
      candidates: cands,
      txId: seed.txId || null,
      eid: seed.eid || null,
      attempts: 0,
      status: seed.status || 'queued', // 'queued' → 'confirming' → (removed on confirm)
      lastError: null,
      // txIds of already-broadcast steps, so a resumed drive never re-sends a
      // step that already landed. sent[0] is the create tx (=== eid).
      sent: Array.isArray(seed.sent) ? seed.sent.slice() : [],
      // Staging-only display seed: shows the pill but is never driven/broadcast.
      demo: !!seed.demo,
      createdAt: seed.createdAt || nowIso(),
    };
  }

  // Record that the create transaction (step 0) was broadcast. eid === txId.
  function markBroadcast(entry, txId) {
    if (!entry) return entry;
    if (txId) { entry.txId = txId; entry.eid = txId; }
    entry.status = 'confirming';
    return entry;
  }

  // The authoritative "this election really persisted" test: the entry has an
  // eid (its create tx was broadcast) AND that eid appears in the server's
  // indexed elections list. Tolerant of extra fields / malformed rows.
  function isConfirmed(entry, electionsList) {
    if (!entry || !entry.eid) return false;
    if (!Array.isArray(electionsList)) return false;
    for (var i = 0; i < electionsList.length; i++) {
      var e = electionsList[i];
      if (e && e.eid === entry.eid) return true;
    }
    return false;
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

  // Serialize the queue for localStorage. Strips transient/derived fields are
  // kept (they're cheap and aid resume); only well-formed entries survive.
  function serialize(queue) {
    var list = Array.isArray(queue) ? queue : [];
    return JSON.stringify(list.filter(isWellFormed));
  }

  // Parse a persisted queue, dropping anything missing the minimum identity
  // (id + name). Never throws — returns [] on malformed JSON.
  function deserialize(str) {
    var parsed;
    try { parsed = JSON.parse(str || '[]'); } catch (_) { return []; }
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWellFormed).map(function (e) {
      return {
        id: e.id,
        name: e.name,
        candidates: Array.isArray(e.candidates) ? e.candidates.slice() : [],
        txId: e.txId || null,
        eid: e.eid || (e.txId || null),
        attempts: typeof e.attempts === 'number' && e.attempts >= 0 ? e.attempts : 0,
        status: e.status === 'confirming' ? 'confirming' : 'queued',
        lastError: typeof e.lastError === 'string' ? e.lastError : null,
        sent: Array.isArray(e.sent) ? e.sent.slice() : [],
        demo: !!e.demo,
        createdAt: e.createdAt || '',
      };
    });
  }

  function isWellFormed(e) {
    return !!(e && typeof e.id === 'string' && e.id &&
              typeof e.name === 'string' && e.name);
  }

  // Pill label. `t` is the app's translator; we look up `queue_saved_locally`
  // and, for n > 1, append the count via `queue_saved_locally_n` ({n} token).
  function summaryLabel(queue, t) {
    var n = Array.isArray(queue) ? queue.length : 0;
    var tr = typeof t === 'function' ? t : function (k) { return k; };
    if (n <= 1) return tr('queue_saved_locally');
    var tpl = tr('queue_saved_locally_n');
    if (tpl && tpl.indexOf('{n}') !== -1) return tpl.replace('{n}', String(n));
    return tr('queue_saved_locally') + ' (' + n + ')';
  }

  return {
    MAX_BACKOFF_MS: MAX_BACKOFF_MS,
    makeEntry: makeEntry,
    markBroadcast: markBroadcast,
    isConfirmed: isConfirmed,
    nextBackoff: nextBackoff,
    serialize: serialize,
    deserialize: deserialize,
    summaryLabel: summaryLabel,
    isWellFormed: isWellFormed,
  };
});

// Quick Count — pure helpers for the inline TPS vote-entry form.
//
// Loaded in the browser as `window.QuickCountInline` (served statically from
// /public) and `require()`d directly by the node --test unit tests. The DOM
// wiring lives in index.html; the validation + summary string-building are
// kept here — pure and side-effect-free — so they can be unit-tested without a
// browser, mirroring /public/csv-export.js.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuickCountInline = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Fixed candidate set for the inline form. `key` is the storage/identifier
  // slug; `name` is the literal label shown in the UI (never translated).
  var CANDIDATES = [
    { key: 'evan', name: 'Evan' },
    { key: 'salah', name: 'Salah' },
    { key: 'circle', name: 'Circle' },
  ];

  // Coerce any input to a non-negative integer. Empty / blank / NaN / negative
  // all collapse to 0; decimals floor toward zero. This is the authoritative
  // sanitizer applied on submit — keystroke filtering in the UI is cosmetic.
  function sanitizeCount(x) {
    var n = Number(String(x == null ? '' : x).trim());
    if (!isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  // Build the "Evan: 1 | Salah: 2 | Circle: 3" status summary from a votes
  // object keyed by candidate slug. Missing fields are treated as 0.
  function formatVoteSummary(votes) {
    var v = votes || {};
    return CANDIDATES
      .map(function (c) { return c.name + ': ' + sanitizeCount(v[c.key]); })
      .join(' | ');
  }

  // Sum of the (sanitized) votes — used for the "Selesai Dihitung" badge total.
  function totalVotes(votes) {
    var v = votes || {};
    return CANDIDATES.reduce(function (s, c) { return s + sanitizeCount(v[c.key]); }, 0);
  }

  // Aggregate per-candidate totals across many station entries. `entries` is an
  // array of `votes` objects (one per saved TPS). Returns an object keyed by
  // candidate slug — e.g. { evan: 10, salah: 6, circle: 3 } — with every slug in
  // CANDIDATES present and missing/dirty fields sanitized to 0. Drives the upper
  // progress bars; its sum is the vote-share denominator.
  function aggregateVotes(entries) {
    var list = entries || [];
    var out = {};
    CANDIDATES.forEach(function (c) { out[c.key] = 0; });
    list.forEach(function (votes) {
      var v = votes || {};
      CANDIDATES.forEach(function (c) { out[c.key] += sanitizeCount(v[c.key]); });
    });
    return out;
  }

  // Convert per-candidate totals into integer 0–100 vote-share percentages,
  // keyed by slug. Denominator is the grand total across all candidates; when
  // that is 0 (nothing entered yet) every share is 0 — never NaN/Infinity.
  // Rounded shares may not sum to exactly 100; acceptable for a working count.
  function voteShares(totals) {
    var tt = totals || {};
    var grand = CANDIDATES.reduce(function (s, c) { return s + sanitizeCount(tt[c.key]); }, 0);
    var out = {};
    CANDIDATES.forEach(function (c) {
      out[c.key] = grand > 0 ? Math.round((sanitizeCount(tt[c.key]) / grand) * 100) : 0;
    });
    return out;
  }

  // Count of station entries that have been saved (`saved === true`). Drives the
  // "X dari N TPS dilaporkan" working-count tracker.
  function reportedCount(entries) {
    return (entries || []).filter(function (e) { return !!(e && e.saved); }).length;
  }

  return {
    CANDIDATES: CANDIDATES,
    sanitizeCount: sanitizeCount,
    formatVoteSummary: formatVoteSummary,
    totalVotes: totalVotes,
    aggregateVotes: aggregateVotes,
    voteShares: voteShares,
    reportedCount: reportedCount,
  };
});

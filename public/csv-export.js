// Quick Count — pure, side-effect-free CSV builders for results exports.
//
// Loaded in the browser as `window.QuickCountCsv` (served statically from
// /public) and `require()`d directly by the node --test unit tests. Keeping
// the string-building here — separate from the DOM `download()` side effect —
// mirrors the "pure functions over plain rows" style in lib/aggregate.js and
// lets the export be unit-tested without a browser or a chain.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QuickCountCsv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Wrap every field in double quotes and escape embedded quotes by doubling,
  // matching the app's existing CSV escaping. Quoting unconditionally keeps
  // commas, quotes and newlines inside candidate names safe.
  function csvField(x) {
    return '"' + String(x == null ? '' : x).replace(/"/g, '""') + '"';
  }

  function csvRow(fields) {
    return fields.map(csvField).join(',');
  }

  // One row per candidate — Rank, Candidate, Votes, Share % — sorted by votes
  // descending so the leader is the first data row. Ties keep candidate (cid)
  // order via a stable index tiebreak and still receive distinct sequential
  // ranks. Vote totals come straight from `d.tally`, which the server already
  // computed under the selected aggregation method. Returns the full CSV text
  // prefixed with a UTF-8 BOM so Excel renders non-Latin candidate names.
  function candidateResultsCsv(d) {
    var candidates = (d && d.candidates) || [];
    var tally = (d && d.tally) || {};
    var votesOf = function (c) { return Number(tally[c.cid] || 0); };
    var total = candidates.reduce(function (s, c) { return s + votesOf(c); }, 0);

    var ranked = candidates
      .map(function (c, i) { return { c: c, i: i, votes: votesOf(c) }; })
      .sort(function (a, b) { return (b.votes - a.votes) || (a.i - b.i); });

    var lines = [csvRow(['Rank', 'Candidate', 'Votes', 'Share %'])];
    ranked.forEach(function (r, idx) {
      var share = total ? Math.round((r.votes / total) * 100) : 0;
      lines.push(csvRow([idx + 1, r.c.name, r.votes, share]));
    });

    return '﻿' + lines.join('\n');
  }

  return {
    candidateResultsCsv: candidateResultsCsv,
    csvField: csvField,
    csvRow: csvRow,
  };
});

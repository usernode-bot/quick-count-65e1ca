// Quick Count — deterministic Evidence document fingerprint (pure, shared).
//
// THE REPRODUCIBILITY CONTRACT. Generate-time (evidence-pdf.js) and verify-time
// (evidence-verify.js) BOTH import this single module to turn a polling-station
// result into a canonical byte string and a SHA-256 fingerprint. If the two
// sides ever produced a different preimage the fingerprint would differ and
// every verification would fail, so the serializer below is FROZEN: do not
// reorder fields, change separators, or alter number/null formatting without
// bumping `fpv` and the golden vectors in test/evidence-fingerprint.test.js.
//
// Loaded in the browser as `window.QCEvidence` (served statically from /public)
// and `require()`d directly by the node --test unit tests — mirroring the
// public/csv-export.js UMD pattern so the logic is testable without a browser.
//
// ── Canonical record (fixed field order) ──────────────────────────────────
//   fpv, app, v, eid, sid, observer, org, txId, createdAt, votes, tot, inv,
//   ev, cid, merkle{root,proof,index}, zk{scheme,commitment,proof}
//
// Only immutable, chain-committed result fields are included. Display names
// (candidate/org/station/election) are deliberately EXCLUDED — they live in
// separate, mutable memos and are not committed by the result transaction.
//
// ── Serialization (the SHA-256 preimage, also the Merkle-leaf preimage) ────
// One `key=value` line per field, joined with '\n':
//   fpv=1
//   app=quickcount
//   v=1
//   eid=<string>
//   sid=<base-10 int | null>
//   observer=<string>
//   org=<string>
//   txId=<string>
//   createdAt=<ISO-8601, ms precision, trailing Z | empty>
//   votes=<cid:count;cid:count… ascending cid, empty when none>
//   tot=<base-10 int | null>
//   inv=<base-10 int | null>
//   ev=<64-hex lowercase | null>
//   cid=<string | null>
//   merkle.root=<string | null>
//   merkle.proof=<h,h,h | null>
//   merkle.index=<base-10 int | null>
//   zk.scheme=<string | null>
//   zk.commitment=<string | null>
//   zk.proof=<string | null>
//
// Worked example — votes {2:5, 1:9} for sid 1 collapses to "votes=1:9;2:5"
// (ascending cid), so vote key order in the source object never affects the
// fingerprint.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QCEvidence = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FPV = 1, APP = 'quickcount', V = 1;
  var MARKER = 'QCEV1.'; // PDF metadata marker prefix: QCEV1.<base64url(json)>
  // base64url payload is parenthesis/backslash-free, so it survives a PDF
  // string literal and a simple regex scan of the raw bytes.
  var MARKER_RE = /QCEV1\.([A-Za-z0-9_-]+)/;

  function posInt(n) {
    var x = Number(n);
    return Number.isFinite(x) ? Math.max(0, Math.round(x)) : null;
  }
  function intOrNull(n) {
    if (n == null || n === '') return null;
    var x = Number(n);
    return Number.isFinite(x) ? Math.round(x) : null;
  }
  function normStr(s) { return s == null ? '' : String(s); }
  function isHash64(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s); }

  // Mirror of lib/memo.js cleanVotes, but emitting a sorted [cid, count] array
  // so there is exactly one serialization regardless of source key order.
  // Accepts either a { "<cid>": count } object (chain shape) or an array of
  // [cid, count] pairs (already-canonical record shape).
  function cleanVotePairs(votes) {
    var entries = [];
    if (Array.isArray(votes)) {
      for (var i = 0; i < votes.length; i++) {
        if (votes[i] == null) continue;
        entries.push([votes[i][0], votes[i][1]]);
      }
    } else if (votes && typeof votes === 'object') {
      var keys = Object.keys(votes);
      for (var j = 0; j < keys.length; j++) entries.push([keys[j], votes[keys[j]]]);
    }
    var out = [], seen = {};
    for (var k = 0; k < entries.length && out.length < 64; k++) {
      var cid = Number(entries[k][0]);
      var n = posInt(entries[k][1]);
      if (Number.isInteger(cid) && cid >= 1 && n != null && !seen[cid]) {
        seen[cid] = true;
        out.push([cid, n]);
      }
    }
    out.sort(function (a, b) { return a[0] - b[0]; });
    return out;
  }

  // ISO-8601, millisecond precision, trailing Z — the single timestamp
  // canonicalization both ends apply so differing upstream precision can't
  // diverge. A null/invalid timestamp serializes to the empty string.
  function isoOrEmpty(value) {
    if (value == null || value === '') return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    return d.toISOString();
  }

  // Normalize arbitrary input into the frozen canonical record. Idempotent: a
  // record that is already canonical (votes is a pair array) re-normalizes to
  // itself, so callers can pass either raw inputs or a decoded record.
  function canonicalRecord(input) {
    input = input || {};
    var merkle = input.merkle || {};
    var zk = input.zk || {};
    return {
      fpv: FPV, app: APP, v: V,
      eid: normStr(input.eid),
      sid: intOrNull(input.sid),
      observer: normStr(input.observer),
      org: normStr(input.org),
      txId: normStr(input.txId),
      createdAt: isoOrEmpty(input.createdAt),
      votes: cleanVotePairs(input.votes),
      tot: intOrNull(input.tot),
      inv: intOrNull(input.inv),
      ev: isHash64(input.ev) ? String(input.ev).toLowerCase() : null,
      cid: input.cid == null || input.cid === '' ? null : normStr(input.cid),
      merkle: {
        root: merkle.root == null || merkle.root === '' ? null : normStr(merkle.root),
        proof: Array.isArray(merkle.proof) ? merkle.proof.map(normStr) : null,
        index: intOrNull(merkle.index),
      },
      zk: {
        scheme: zk.scheme == null || zk.scheme === '' ? null : normStr(zk.scheme),
        commitment: zk.commitment == null || zk.commitment === '' ? null : normStr(zk.commitment),
        proof: zk.proof == null || zk.proof === '' ? null : normStr(zk.proof),
      },
    };
  }

  function val(x) { return x == null ? 'null' : String(x); }

  // The frozen SHA-256 / Merkle-leaf preimage. Always normalizes first so the
  // output depends only on the record's meaning, never on its construction.
  function serialize(rec) {
    var r = canonicalRecord(rec);
    var votesStr = r.votes.map(function (p) { return p[0] + ':' + p[1]; }).join(';');
    return [
      'fpv=' + r.fpv,
      'app=' + r.app,
      'v=' + r.v,
      'eid=' + r.eid,
      'sid=' + val(r.sid),
      'observer=' + r.observer,
      'org=' + r.org,
      'txId=' + r.txId,
      'createdAt=' + r.createdAt,
      'votes=' + votesStr,
      'tot=' + val(r.tot),
      'inv=' + val(r.inv),
      'ev=' + val(r.ev),
      'cid=' + val(r.cid),
      'merkle.root=' + val(r.merkle.root),
      'merkle.proof=' + (r.merkle.proof ? r.merkle.proof.join(',') : 'null'),
      'merkle.index=' + val(r.merkle.index),
      'zk.scheme=' + val(r.zk.scheme),
      'zk.commitment=' + val(r.zk.commitment),
      'zk.proof=' + val(r.zk.proof),
    ].join('\n');
  }

  function bytesToHex(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
  }

  // Cross-environment SHA-256 → hex. Prefers WebCrypto (browser + Node 18+),
  // falls back to node's crypto module. Always returns a Promise<hex>.
  function sha256Hex(str) {
    var subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
    if (!subtle && typeof require === 'function') {
      try { subtle = require('crypto').webcrypto.subtle; } catch (e) { subtle = null; }
    }
    if (subtle && subtle.digest) {
      var data;
      if (typeof TextEncoder !== 'undefined') data = new TextEncoder().encode(str);
      else data = Buffer.from(str, 'utf8');
      return Promise.resolve(subtle.digest('SHA-256', data)).then(bytesToHex);
    }
    if (typeof require === 'function') {
      try {
        return Promise.resolve(require('crypto').createHash('sha256').update(str, 'utf8').digest('hex'));
      } catch (e) { /* fall through */ }
    }
    return Promise.reject(new Error('No SHA-256 implementation available'));
  }

  function fingerprint(rec) { return sha256Hex(serialize(rec)); }

  // ── base64url (no padding) — cross-env ─────────────────────────────────────
  function toBase64Url(str) {
    var b64;
    if (typeof Buffer !== 'undefined') b64 = Buffer.from(str, 'utf8').toString('base64');
    else b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromBase64Url(s) {
    var b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8');
    return decodeURIComponent(escape(atob(b64)));
  }

  // PDF-embed encoding: "QCEV1." + base64url(JSON of the canonical record).
  function encodeRecord(rec) {
    return MARKER + toBase64Url(JSON.stringify(canonicalRecord(rec)));
  }
  // Decode a "QCEV1.<b64url>" marker back to a canonical record, or null.
  function decodeRecord(markerOrPayload) {
    if (typeof markerOrPayload !== 'string') return null;
    var m = markerOrPayload.match(MARKER_RE);
    var payload = m ? m[1] : markerOrPayload;
    try {
      var obj = JSON.parse(fromBase64Url(payload));
      return canonicalRecord(obj);
    } catch (e) { return null; }
  }
  // Find the first QCEV1 marker embedded in arbitrary text (e.g. raw PDF bytes
  // decoded as latin1). Returns the decoded canonical record or null.
  function extractFromText(text) {
    if (typeof text !== 'string') return null;
    var m = text.match(MARKER_RE);
    return m ? decodeRecord(m[0]) : null;
  }

  return {
    FPV: FPV, APP: APP, V: V, MARKER: MARKER, MARKER_RE: MARKER_RE,
    posInt: posInt, isHash64: isHash64, cleanVotePairs: cleanVotePairs,
    canonicalRecord: canonicalRecord, serialize: serialize,
    sha256Hex: sha256Hex, fingerprint: fingerprint,
    toBase64Url: toBase64Url, fromBase64Url: fromBase64Url,
    encodeRecord: encodeRecord, decodeRecord: decodeRecord, extractFromText: extractFromText,
  };
});

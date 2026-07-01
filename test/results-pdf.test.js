'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { available, fmtTimestamp, fmtDate } = require('../public/results-pdf.js');

// Fixed instant so every assertion below is deterministic regardless of when
// the test runs. 2026-03-05T14:30:00Z.
const WHEN = '2026-03-05T14:30:00Z';

test('available: false under Node (no window.jspdf/QuickCountInline loaded)', () => {
  assert.strictEqual(available(), false);
});

test('fmtTimestamp: localizes month names per language instead of hardcoded English', () => {
  const en = fmtTimestamp(WHEN, 'en');
  const id = fmtTimestamp(WHEN, 'id');
  const fr = fmtTimestamp(WHEN, 'fr');
  assert.match(en, /March/);
  assert.match(id, /Maret/);
  assert.match(fr, /mars/);
  // The three languages must actually render differently — otherwise the
  // stamp isn't really localized, just always falling back to English.
  assert.notStrictEqual(en, id);
  assert.notStrictEqual(en, fr);
});

test('fmtTimestamp: unrecognized language code falls back to English', () => {
  const fallback = fmtTimestamp(WHEN, 'not-a-real-lang');
  const en = fmtTimestamp(WHEN, 'en');
  assert.strictEqual(fallback, en);
});

test('fmtTimestamp: missing language code falls back to English', () => {
  const fallback = fmtTimestamp(WHEN, undefined);
  const en = fmtTimestamp(WHEN, 'en');
  assert.strictEqual(fallback, en);
});

test('fmtDate: still produces a plain YYYY-MM-DD filename-safe date regardless of language', () => {
  assert.strictEqual(fmtDate(WHEN), '2026-03-05');
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { sanitizeCount, formatVoteSummary, totalVotes, CANDIDATES } = require('../public/inline-entry.js');

test('sanitizeCount: empty / blank / null default to 0', () => {
  assert.strictEqual(sanitizeCount(''), 0);
  assert.strictEqual(sanitizeCount('   '), 0);
  assert.strictEqual(sanitizeCount(null), 0);
  assert.strictEqual(sanitizeCount(undefined), 0);
});

test('sanitizeCount: negatives clamp to 0', () => {
  assert.strictEqual(sanitizeCount(-5), 0);
  assert.strictEqual(sanitizeCount('-12'), 0);
});

test('sanitizeCount: decimals floor toward zero', () => {
  assert.strictEqual(sanitizeCount(3.9), 3);
  assert.strictEqual(sanitizeCount('7.2'), 7);
  assert.strictEqual(sanitizeCount(0.5), 0);
});

test('sanitizeCount: non-numeric text becomes 0', () => {
  assert.strictEqual(sanitizeCount('abc'), 0);
  assert.strictEqual(sanitizeCount('12x'), 0);
});

test('sanitizeCount: large values pass through as integers', () => {
  assert.strictEqual(sanitizeCount('100000'), 100000);
  assert.strictEqual(sanitizeCount(42), 42);
});

test('formatVoteSummary: exact "Name: n | …" string', () => {
  assert.strictEqual(
    formatVoteSummary({ evan: 1, salah: 2, circle: 3 }),
    'Evan: 1 | Salah: 2 | Circle: 3'
  );
});

test('formatVoteSummary: missing / dirty fields sanitize to 0 and floor', () => {
  assert.strictEqual(
    formatVoteSummary({ evan: '', salah: -4, circle: 5.8 }),
    'Evan: 0 | Salah: 0 | Circle: 5'
  );
  assert.strictEqual(formatVoteSummary({}), 'Evan: 0 | Salah: 0 | Circle: 0');
  assert.strictEqual(formatVoteSummary(null), 'Evan: 0 | Salah: 0 | Circle: 0');
});

test('totalVotes: sums sanitized counts', () => {
  assert.strictEqual(totalVotes({ evan: 1, salah: 2, circle: 3 }), 6);
  assert.strictEqual(totalVotes({ evan: '10', salah: -1, circle: 2.9 }), 12);
});

test('CANDIDATES: fixed Evan/Salah/Circle order', () => {
  assert.deepStrictEqual(CANDIDATES.map((c) => c.name), ['Evan', 'Salah', 'Circle']);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  sanitizeCount,
  formatVoteSummary,
  totalVotes,
  aggregateVotes,
  voteShares,
  reportedCount,
  CANDIDATES,
  adjustSharesTo100,
} = require('../public/inline-entry.js');

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

test('aggregateVotes: sums each slug across entries', () => {
  assert.deepStrictEqual(
    aggregateVotes([
      { evan: 1, salah: 2, circle: 3 },
      { evan: 4, salah: 5, circle: 6 },
    ]),
    { evan: 5, salah: 7, circle: 9 }
  );
});

test('aggregateVotes: sanitizes dirty / missing fields to 0', () => {
  assert.deepStrictEqual(
    aggregateVotes([
      { evan: '10', salah: -3, circle: 2.9 },
      { evan: 'abc', circle: '1' },
    ]),
    { evan: 10, salah: 0, circle: 3 }
  );
});

test('aggregateVotes: empty / null input → all zeros', () => {
  assert.deepStrictEqual(aggregateVotes([]), { evan: 0, salah: 0, circle: 0 });
  assert.deepStrictEqual(aggregateVotes(null), { evan: 0, salah: 0, circle: 0 });
});

test('voteShares: integer percentages over the grand total', () => {
  assert.deepStrictEqual(
    voteShares({ evan: 1, salah: 2, circle: 1 }),
    { evan: 25, salah: 50, circle: 25 }
  );
});

test('voteShares: divide-by-zero → all zeros (never NaN/Infinity)', () => {
  assert.deepStrictEqual(voteShares({ evan: 0, salah: 0, circle: 0 }), { evan: 0, salah: 0, circle: 0 });
  assert.deepStrictEqual(voteShares({}), { evan: 0, salah: 0, circle: 0 });
  assert.deepStrictEqual(voteShares(null), { evan: 0, salah: 0, circle: 0 });
});

test('voteShares: rounds and sanitizes dirty totals', () => {
  // grand total 3 → 1/3 ≈ 33, 2/3 ≈ 67
  assert.deepStrictEqual(voteShares({ evan: 1, salah: 2, circle: -5 }), { evan: 33, salah: 67, circle: 0 });
});

test('reportedCount: counts only saved entries', () => {
  assert.strictEqual(reportedCount([{ saved: true }, { saved: false }, { saved: true }]), 2);
  assert.strictEqual(reportedCount([{ saved: false }]), 0);
  assert.strictEqual(reportedCount([]), 0);
  assert.strictEqual(reportedCount(null), 0);
  assert.strictEqual(reportedCount([null, undefined, { saved: true }]), 1);
});

test('adjustSharesTo100: three-way tie always sums to exactly 100', () => {
  const pcts = adjustSharesTo100([1, 1, 1]);
  assert.strictEqual(pcts.reduce((a, b) => a + b, 0), 100);
  // naive rounding would give 33/33/33 = 99; the gap goes to the earliest tie
  assert.deepStrictEqual(pcts, [34, 33, 33]);
});

test('adjustSharesTo100: excess remainder is trimmed from the largest share', () => {
  // 2/7 ≈ 28.57 (round 29) three times = 87, plus 1/7 ≈ 14.29 (round 14) = 101
  const pcts = adjustSharesTo100([2, 2, 2, 1]);
  assert.strictEqual(pcts.reduce((a, b) => a + b, 0), 100);
});

test('adjustSharesTo100: all-zero / empty input never divides by zero', () => {
  assert.deepStrictEqual(adjustSharesTo100([0, 0, 0]), [0, 0, 0]);
  assert.deepStrictEqual(adjustSharesTo100([]), []);
  assert.deepStrictEqual(adjustSharesTo100(null), []);
});

test('adjustSharesTo100: exact division needs no adjustment', () => {
  assert.deepStrictEqual(adjustSharesTo100([1, 1, 1, 1]), [25, 25, 25, 25]);
});

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { candidateResultsCsv } = require('../public/csv-export.js');

// Strip the leading UTF-8 BOM and split into lines for easy row assertions.
function rows(csv) {
  return csv.replace(/^﻿/, '').split('\n');
}

test('header + one row per candidate, sorted by votes descending', () => {
  const d = {
    election: { name: 'Demo' },
    method: 'latest',
    candidates: [{ cid: 1, name: 'Red' }, { cid: 2, name: 'Blue' }, { cid: 3, name: 'Green' }],
    tally: { 1: 50, 2: 120, 3: 30 }, // total 200
  };
  const lines = rows(candidateResultsCsv(d));
  assert.strictEqual(lines[0], '"Rank","Candidate","Votes","Share %"');
  assert.strictEqual(lines.length, 4); // header + 3 candidates
  assert.deepStrictEqual(lines.slice(1), [
    '"1","Blue","120","60"',
    '"2","Red","50","25"',
    '"3","Green","30","15"',
  ]);
});

test('output begins with a UTF-8 BOM', () => {
  const csv = candidateResultsCsv({ candidates: [{ cid: 1, name: 'A' }], tally: { 1: 1 } });
  assert.strictEqual(csv.charCodeAt(0), 0xfeff);
});

test('no candidates yields a header-only file', () => {
  const lines = rows(candidateResultsCsv({ candidates: [], tally: {} }));
  assert.strictEqual(lines.length, 1);
  assert.strictEqual(lines[0], '"Rank","Candidate","Votes","Share %"');
});

test('zero total votes gives 0% share with no divide-by-zero', () => {
  const d = { candidates: [{ cid: 1, name: 'A' }, { cid: 2, name: 'B' }], tally: {} };
  const lines = rows(candidateResultsCsv(d));
  assert.strictEqual(lines[1], '"1","A","0","0"');
  assert.strictEqual(lines[2], '"2","B","0","0"');
});

test('commas and quotes in candidate names are escaped', () => {
  const d = { candidates: [{ cid: 1, name: 'Smith, "JR"' }], tally: { 1: 10 } };
  const lines = rows(candidateResultsCsv(d));
  assert.strictEqual(lines[1], '"1","Smith, ""JR""","10","100"');
});

test('ties keep candidate (cid) order with distinct sequential ranks', () => {
  const d = {
    candidates: [{ cid: 1, name: 'First' }, { cid: 2, name: 'Second' }],
    tally: { 1: 10, 2: 10 },
  };
  const lines = rows(candidateResultsCsv(d));
  assert.strictEqual(lines[1], '"1","First","10","50"');
  assert.strictEqual(lines[2], '"2","Second","10","50"');
});

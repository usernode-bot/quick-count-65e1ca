'use strict';
// Focused guard for the 2024 Indonesian presidential presentation dataset.
// Ensures the additive demo election keeps its expected shape (3 candidate
// pairs, 5 province-tagged stations, 4 reported, consensus station) and that
// the original generic demo-election is left untouched.
const { test } = require('node:test');
const assert = require('node:assert');

const { QuickCountIndexer } = require('../lib/indexer');
const { buildDemoTxs, PILPRES_EID } = require('../server');

const CFG = { treasury: 'ut1treasuryquickcount00000000000000000000', orgFee: 100, adminAddrs: [] };

function index() {
  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(buildDemoTxs());
  return ix;
}

test('Pilpres 2024 demo election exists alongside the generic demo election', () => {
  const ix = index();
  assert.ok(ix.elections.has('demo-election'), 'generic demo-election still present');
  assert.ok(ix.elections.has(PILPRES_EID), 'pilpres election present');
  const el = ix.elections.get(PILPRES_EID);
  assert.match(el.name, /Pilpres 2024/);
});

test('Pilpres 2024 dataset has 3 candidate pairs and 5 province stations', () => {
  const ix = index();
  const cands = ix.candidates.get(PILPRES_EID);
  assert.strictEqual(cands.size, 3);
  assert.match(cands.get(1).name, /Anies/);
  assert.match(cands.get(2).name, /Prabowo/);
  assert.match(cands.get(3).name, /Ganjar/);

  const stations = ix.stations.get(PILPRES_EID);
  assert.strictEqual(stations.size, 5);
  const labels = Array.from(stations.values()).map((s) => s.label);
  assert.deepStrictEqual(
    labels.sort(),
    ['DKI Jakarta', 'Jawa Barat', 'Jawa Tengah', 'Jawa Timur', 'Sumatera Utara']
  );
});

test('Pilpres 2024 has 4 of 5 stations reported with a dual-submission station', () => {
  const ix = index();
  const summary = ix.electionSummary(ix.elections.get(PILPRES_EID));
  assert.strictEqual(summary.candidateCount, 3);
  assert.strictEqual(summary.stationCount, 5);
  assert.strictEqual(summary.reportedCount, 4, 'station 5 left unreported');

  // Station 3 carries two observer submissions (consensus / median path).
  const results = ix.results.get(PILPRES_EID) || [];
  const s3 = results.filter((r) => r.sid === 3);
  assert.strictEqual(s3.length, 2, 'station 3 has two submissions');
});

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

test('Pilpres 2024 latest-aggregate national shares track the real 2024 result', () => {
  const ix = index();
  // The Dashboard's default aggregation method is 'latest' (config.methods[0]);
  // the displayed national shares come from this tally.
  const detail = ix.electionDetail(PILPRES_EID, 'latest');
  const tally = detail.tally;
  const total = Object.values(tally).reduce((s, n) => s + Number(n || 0), 0);
  assert.ok(total > 0, 'has votes');

  const pct = (cid) => (100 * Number(tally[cid] || 0)) / total;
  const TARGET = { 1: 24.95, 2: 58.59, 3: 16.47 }; // Anies / Prabowo / Ganjar
  for (const cid of [1, 2, 3]) {
    const diff = Math.abs(pct(cid) - TARGET[cid]);
    assert.ok(
      diff <= 0.5,
      `cid ${cid} share ${pct(cid).toFixed(2)}% within 0.5pp of ${TARGET[cid]}% (off by ${diff.toFixed(2)})`
    );
  }
  // Prabowo–Gibran (cid 2) is the clear winner.
  assert.ok(Number(tally[2]) > Number(tally[1]), 'Prabowo leads Anies');
  assert.ok(Number(tally[2]) > Number(tally[3]), 'Prabowo leads Ganjar');
});

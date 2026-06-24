'use strict';
// Golden-vector + invariance tests for the frozen Evidence fingerprint
// serializer. If any of these change, the PDF format has diverged and existing
// Evidence PDFs would stop verifying — bump `fpv` and regenerate the goldens
// deliberately, never silently.
const test = require('node:test');
const assert = require('node:assert');
const FP = require('../public/evidence-fingerprint.js');

const BASE = {
  eid: 'el-tx-0001',
  sid: 1,
  observer: 'ut1observerAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  org: 'ut1orgBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  txId: 'res-tx-0001',
  createdAt: '2026-06-01T00:00:00.000Z',
  votes: { 2: 5, 1: 9 },
  tot: 14,
  inv: 0,
  ev: null,
};

// Pinned golden serialization — the exact SHA-256 preimage.
const GOLDEN_SERIALIZE = [
  'fpv=1',
  'app=quickcount',
  'v=1',
  'eid=el-tx-0001',
  'sid=1',
  'observer=ut1observerAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  'org=ut1orgBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  'txId=res-tx-0001',
  'createdAt=2026-06-01T00:00:00.000Z',
  'votes=1:9;2:5',
  'tot=14',
  'inv=0',
  'ev=null',
  'cid=null',
  'merkle.root=null',
  'merkle.proof=null',
  'merkle.index=null',
  'zk.scheme=null',
  'zk.commitment=null',
  'zk.proof=null',
].join('\n');

// Pinned golden fingerprint for BASE (SHA-256 of GOLDEN_SERIALIZE).
const GOLDEN_FP = '4a18eca337b0d109c0b9d62c76a932a1ae2bd9d0c4bbe2e9805009f17702f122';

test('serialize produces the frozen canonical preimage', () => {
  assert.strictEqual(FP.serialize(BASE), GOLDEN_SERIALIZE);
});

test('fingerprint matches the pinned golden vector', async () => {
  const fp = await FP.fingerprint(BASE);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.strictEqual(fp, GOLDEN_FP);
});

test('vote key order does not affect the fingerprint', async () => {
  const reordered = Object.assign({}, BASE, { votes: { 1: 9, 2: 5 } });
  const a = await FP.fingerprint(BASE);
  const b = await FP.fingerprint(reordered);
  assert.strictEqual(a, b);
});

test('votes as a pair-array reproduce the object fingerprint', async () => {
  const asPairs = Object.assign({}, BASE, { votes: [[2, 5], [1, 9]] });
  assert.strictEqual(await FP.fingerprint(asPairs), GOLDEN_FP);
});

test('timestamp precision is canonicalized via toISOString', async () => {
  const a = await FP.fingerprint(Object.assign({}, BASE, { createdAt: '2026-06-01T00:00:00Z' }));
  const b = await FP.fingerprint(Object.assign({}, BASE, { createdAt: '2026-06-01T00:00:00.000Z' }));
  assert.strictEqual(a, b, 'differing source precision must canonicalize identically');
  assert.strictEqual(a, GOLDEN_FP);
});

test('null tot/inv/ev serialize as explicit null tokens', () => {
  const s = FP.serialize(Object.assign({}, BASE, { tot: null, inv: null, ev: null }));
  assert.ok(s.includes('\ntot=null\n'));
  assert.ok(s.includes('\ninv=null\n'));
  assert.ok(s.includes('\nev=null\n'));
});

test('tampering any covered field changes the fingerprint', async () => {
  const base = await FP.fingerprint(BASE);
  const mutations = [
    { votes: { 1: 10, 2: 5 } },
    { tot: 15 },
    { inv: 1 },
    { observer: 'ut1someoneelse0000000000000000000000000000' },
    { org: 'ut1otherorg000000000000000000000000000000' },
    { txId: 'res-tx-0002' },
    { createdAt: '2026-06-01T00:00:01.000Z' },
    { sid: 2 },
    { eid: 'el-tx-0002' },
  ];
  for (const m of mutations) {
    const fp = await FP.fingerprint(Object.assign({}, BASE, m));
    assert.notStrictEqual(fp, base, 'mutation should change fingerprint: ' + JSON.stringify(m));
  }
});

test('ev normalizes to lowercase 64-hex; non-hex becomes null', () => {
  const hex = 'AB'.repeat(32);
  const rec = FP.canonicalRecord(Object.assign({}, BASE, { ev: hex }));
  assert.strictEqual(rec.ev, hex.toLowerCase());
  const bad = FP.canonicalRecord(Object.assign({}, BASE, { ev: 'not-a-hash' }));
  assert.strictEqual(bad.ev, null);
});

test('votes are capped at 64 entries and exclude invalid cids', () => {
  const votes = {};
  for (let i = 1; i <= 80; i++) votes[i] = i;
  votes['0'] = 99;   // cid < 1 → dropped
  votes['-3'] = 7;   // negative → dropped
  const rec = FP.canonicalRecord(Object.assign({}, BASE, { votes: votes }));
  assert.strictEqual(rec.votes.length, 64);
  assert.ok(rec.votes.every((p) => p[0] >= 1));
});

test('encodeRecord/decodeRecord round-trips to the same fingerprint', async () => {
  const marker = FP.encodeRecord(BASE);
  assert.ok(marker.startsWith('QCEV1.'));
  const decoded = FP.decodeRecord(marker);
  assert.strictEqual(await FP.fingerprint(decoded), GOLDEN_FP);
  // Marker embedded in surrounding text (simulating a PDF byte scan).
  const fromText = FP.extractFromText('%PDF noise ... ' + marker + ' ... more bytes');
  assert.strictEqual(await FP.fingerprint(fromText), GOLDEN_FP);
});

test('base64url payload is parenthesis/backslash free (PDF-safe)', () => {
  const marker = FP.encodeRecord(BASE);
  const payload = marker.slice('QCEV1.'.length);
  assert.match(payload, /^[A-Za-z0-9_-]+$/);
});

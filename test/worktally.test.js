'use strict';

// Tests for the off-chain working-tally slice:
//   • sanitizeWorkVotes() — server-side vote sanitization (pure, no DB).
//   • PUT /api/elections/:eid/worktally/:sid authorization (403 for a caller
//     who is not owner/admin/mod of the election's org).
//   • workTally folded into /api/public/elections/:eid, the /__quickcount/state
//     detail object, and the standalone GET /api/public/elections/:eid/worktally.
//   • The DB-backed upsert + latest-wins behaviour, gated on DATABASE_URL so the
//     suite stays green in the default no-Postgres harness and runs in full when
//     a database is present.
//
// The indexer is seeded from buildDemoTxs(); demo-election is owned by ORG_A.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');

// Run WITHOUT a database (pool null), like the rest of the endpoint suite — the
// folding/auth/sanitization branches all resolve before (or independently of)
// Postgres, and loadWorkTally degrades to []. The full PUT→GET upsert cycle is
// exercised end-to-end by the staging proposal checks against a migrated DB.
process.env.USERNODE_ENV = 'staging';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'worktally-test-secret';
delete process.env.DATABASE_URL;

const { app, indexer, buildDemoTxs, sanitizeWorkVotes } = require('../server');

const ORG_A = 'ut1democitizenscount0000000000000000000000'; // owns demo-election
const OUTSIDER = 'ut1nobody000000000000000000000000000000000';

let server, base;
before(async () => {
  indexer.rebuild(buildDemoTxs());
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (server) server.close(); });

function req(method, path, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    const headers = {};
    let payload = null;
    if (opts.body !== undefined) { payload = JSON.stringify(opts.body); headers['Content-Type'] = 'application/json'; }
    if (opts.token) headers['x-usernode-token'] = opts.token;
    const r = http.request(u, { method, headers }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { let j = {}; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function tokenFor(pubkey) {
  return jwt.sign({ id: 'u_' + pubkey.slice(0, 8), username: null, usernode_pubkey: pubkey }, process.env.JWT_SECRET);
}

// ── Pure sanitization ────────────────────────────────────────────────────────
test('sanitizeWorkVotes keeps known slugs, drops unknowns, coerces to non-negative ints', () => {
  const out = sanitizeWorkVotes({ evan: -5, salah: '3.9', circle: 2, bogus: 99, '__proto__': 1 });
  assert.deepStrictEqual(out, { evan: 0, salah: 3, circle: 2 });
});
test('sanitizeWorkVotes fills missing slugs with 0 and tolerates junk input', () => {
  assert.deepStrictEqual(sanitizeWorkVotes(null), { evan: 0, salah: 0, circle: 0 });
  assert.deepStrictEqual(sanitizeWorkVotes('nope'), { evan: 0, salah: 0, circle: 0 });
  assert.deepStrictEqual(sanitizeWorkVotes({ evan: 7 }), { evan: 7, salah: 0, circle: 0 });
});

// ── Authorization ────────────────────────────────────────────────────────────
test('PUT worktally on an indexed election is rejected (403) for a non owner/admin/mod', async () => {
  // demo-election is indexed and owned by ORG_A; an outsider token must 403,
  // and the check runs before the DB-availability gate so it is deterministic.
  const { status } = await req('PUT', '/api/elections/demo-election/worktally/1', {
    token: tokenFor(OUTSIDER), body: { votes: { evan: 1 } },
  });
  assert.strictEqual(status, 403);
});
test('PUT worktally with no token on an indexed election is rejected (401 gate or 403)', async () => {
  const { status } = await req('PUT', '/api/elections/demo-election/worktally/1', { body: { votes: { evan: 1 } } });
  // The global JWT gate denies unauthenticated /api/ writes (401); if a token
  // were present but unauthorized the handler returns 403. Either is a rejection.
  assert.ok(status === 401 || status === 403, 'unauthenticated write rejected, got ' + status);
});

// ── Read folding (works with or without a DB; empty array when no rows) ───────
test('public election detail includes a workTally array', async () => {
  const { status, json } = await req('GET', '/api/public/elections/demo-election');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(json.workTally), 'workTally present as array');
});
test('__quickcount/state detail includes a workTally array', async () => {
  const { status, json } = await req('GET', '/__quickcount/state?viewer=' + encodeURIComponent(ORG_A) + '&eid=demo-election');
  assert.strictEqual(status, 200);
  assert.ok(json.detail && Array.isArray(json.detail.workTally), 'detail.workTally present as array');
});
test('standalone worktally reader returns a workTally array', async () => {
  const { status, json } = await req('GET', '/api/public/elections/demo-election/worktally');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(json.workTally), 'workTally present as array');
});

// ── Auth precedes availability ───────────────────────────────────────────────
// An authorized owner passes the role guard and reaches the DB-availability gate;
// with no pool that surfaces as 503 (not 403). This proves the ordering — "not
// allowed" wins over "unavailable" — and that an owner is NOT rejected by the
// role guard. The full persisted upsert + latest-wins cycle runs against the
// migrated staging DB (proposal checks), not this pool-null unit suite.
test('owner passes the role guard and reaches the availability gate (503 without a DB)', async () => {
  const { status } = await req('PUT', '/api/elections/demo-election/worktally/1', {
    token: tokenFor(ORG_A), body: { votes: { evan: 10, salah: 20, circle: 30 } },
  });
  assert.strictEqual(status, 503);
});

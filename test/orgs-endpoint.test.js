'use strict';

// Endpoint test for GET /__quickcount/orgs and the private-org filter on the
// public elections endpoint. Runs WITHOUT a database (pool null); the shared
// indexer is seeded directly from buildDemoTxs() so we exercise the read path.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.USERNODE_ENV = 'staging';
delete process.env.DATABASE_URL;

const { app, indexer, buildDemoTxs } = require('../server');

// Demo wallet addresses (mirror server.js DEMO map).
const ORG_A = 'ut1democitizenscount0000000000000000000000';
const ORG_ADMIN = 'ut1demoorgadmin0000000000000000000000000000';
const ORG_MEMBER = 'ut1demoorgmember00000000000000000000000000';
const ORG_C = 'ut1demoprivateorg00000000000000000000000000';
const ORG_D = 'ut1demodeletedorg00000000000000000000000000';

let server, base;
before(async () => {
  indexer.rebuild(buildDemoTxs());
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (server) server.close(); });

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(new URL(base + path), (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => { let j = {}; try { j = JSON.parse(buf); } catch (_) {} resolve({ status: res.statusCode, json: j }); });
    }).on('error', reject);
  });
}

test('owner sees their org with the full roster', async () => {
  const { status, json } = await get('/__quickcount/orgs?viewer=' + encodeURIComponent(ORG_A));
  assert.strictEqual(status, 200);
  const org = json.orgs.find((o) => o.addr === ORG_A);
  assert.ok(org, 'owned org present');
  assert.strictEqual(org.viewerRole, 'owner');
  assert.strictEqual(org.members[0].role, 'owner');
  const roles = Object.fromEntries(org.members.map((m) => [m.addr, m.role]));
  assert.strictEqual(roles[ORG_ADMIN], 'admin');
  assert.strictEqual(roles[ORG_MEMBER], 'member');
});

test('the orgs projection exposes active so the client can gate management', async () => {
  // The locked-vs-unlocked Manage workspace keys off org.active; the endpoint
  // must surface it. Citizens Count is paid → active true.
  const { json } = await get('/__quickcount/orgs?viewer=' + encodeURIComponent(ORG_A));
  const org = json.orgs.find((o) => o.addr === ORG_A);
  assert.strictEqual(org.active, true);
});

test('an administrator sees the org under member-of with role admin', async () => {
  const { json } = await get('/__quickcount/orgs?viewer=' + encodeURIComponent(ORG_ADMIN));
  const org = json.orgs.find((o) => o.addr === ORG_A);
  assert.ok(org);
  assert.strictEqual(org.viewerRole, 'admin');
});

test('a member of the private org sees it; the deleted org is excluded', async () => {
  const { json } = await get('/__quickcount/orgs?viewer=' + encodeURIComponent(ORG_MEMBER));
  const addrs = json.orgs.map((o) => o.addr);
  assert.ok(addrs.includes(ORG_A));   // member of Citizens Count
  assert.ok(addrs.includes(ORG_C));   // member of the private org
  assert.ok(!addrs.includes(ORG_D));  // deleted org never surfaces
  const priv = json.orgs.find((o) => o.addr === ORG_C);
  assert.strictEqual(priv.visibility, 'private');
});

test('an outsider sees no orgs', async () => {
  const { json } = await get('/__quickcount/orgs?viewer=ut1nobody000000000000000000000000000000000');
  assert.strictEqual(json.orgs.length, 0);
});

test('public elections endpoint excludes the private org election', async () => {
  const { status, json } = await get('/api/public/elections');
  assert.strictEqual(status, 200);
  const eids = json.elections.map((e) => e.eid);
  assert.ok(eids.includes('demo-election'), 'public election listed');
  assert.ok(!eids.includes('demo_elc'), 'private-org election hidden from public');
});

test('the private election 404s for an anonymous viewer', async () => {
  const { status } = await get('/api/public/elections/demo_elc');
  assert.strictEqual(status, 404);
});

'use strict';

// Endpoint test for GET /__quickcount/state — covers the activeOrgs projection
// added so the "Organisasi aktif" list surfaces active orgs directly (not
// derived from elections). Runs without a database; the indexer is in-memory,
// so we rebuild it from a small transaction fixture and read it back over HTTP.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.USERNODE_ENV = 'staging';
delete process.env.DATABASE_URL;

const memo = require('../lib/memo');
const { app, indexer } = require('../server');

let server, base;
let _t = Date.parse('2026-06-19T08:00:00.000Z');
function mk(txId, from, to, amount, env) {
  _t += 60000;
  return { txId, from, to, amount, memo: memo.encode(env), createdAt: new Date(_t).toISOString() };
}

before(async () => {
  // Treasury/orgFee come from the server's own config; pay exactly what the
  // indexer was constructed with so the paid org activates.
  const treasury = indexer.treasury;
  const fee = indexer.orgFee;
  indexer.rebuild([
    // Active org with NO elections — must appear in activeOrgs.
    mk('o_active', 'ut1activeorg', treasury, fee, memo.orgMemo('Active No-Election Org', 'Demoland')),
    // Pending/unpaid org — must be excluded.
    mk('o_pending', 'ut1pendingorg', treasury, 0, memo.orgMemo('Pending Org')),
  ]);
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (server) server.close(); });

function get(path) {
  return new Promise((resolve, reject) => {
    const u = new URL(base + path);
    http.get(u, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    }).on('error', reject);
  });
}

test('GET /__quickcount/state returns activeOrgs incl. the election-less active org, excludes pending', async () => {
  const { status, json } = await get('/__quickcount/state');
  assert.strictEqual(status, 200);
  assert.ok(Array.isArray(json.activeOrgs));
  const addrs = json.activeOrgs.map((o) => o.addr);
  assert.ok(addrs.includes('ut1activeorg'));
  assert.ok(!addrs.includes('ut1pendingorg'));
  const active = json.activeOrgs.find((o) => o.addr === 'ut1activeorg');
  assert.deepStrictEqual(active, { addr: 'ut1activeorg', name: 'Active No-Election Org', jur: 'Demoland' });
});

test('GET /__quickcount/state still carries role, elections, detail, method', async () => {
  const { json } = await get('/__quickcount/state');
  assert.ok('role' in json);
  assert.ok(Array.isArray(json.elections));
  assert.ok('detail' in json);
  assert.strictEqual(typeof json.method, 'string');
});

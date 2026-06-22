'use strict';

// Endpoint test for the browser-facing chain read proxy:
//   POST /explorer-api/<chain>/transactions
// The client confirmation poll (index.html / dashboard.html) hits this path to
// wait for a just-sent transaction to appear on the ledger. It must forward the
// query to the configured upstream (EXPLORER_API_URL, addressed per-chain) and
// return the upstream JSON/status verbatim — guarding against the route ever
// silently 404ing again (the original on-chain confirmation bug).

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Configure an explorer upstream + chain id BEFORE requiring server.js — both
// are read at module load. No DB (pool null), production-ish (not local-dev).
process.env.EXPLORER_API_URL = 'https://ex.test/explorer-api';
process.env.CHAIN_ID = 'usernode';
process.env.USERNODE_ENV = 'production';
delete process.env.APP_MODE;
delete process.env.NODE_RPC_URL;
delete process.env.DATABASE_URL;

// Stub global.fetch so the proxy's upstream call is captured, not actually made.
// The test client below uses node:http (not fetch), so there's no interference.
const realFetch = global.fetch;
let seenUrl = null;
let seenBody = null;
global.fetch = async (url, opts) => {
  seenUrl = url;
  try { seenBody = JSON.parse(opts.body); } catch { seenBody = null; }
  return {
    ok: true,
    status: 200,
    json: async () => ({ transactions: [{ id: 'tx-abc', from: 'ut1a', to: 'ut1b' }] }),
  };
};

const { app } = require('../server');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => {
  if (server) server.close();
  global.fetch = realFetch;
});

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(base + path);
    const r = http.request(u, {
      method,
      headers: data ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = {};
        try { json = JSON.parse(buf); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

test('proxy forwards to the per-chain explorer upstream and returns its payload', async () => {
  seenUrl = null; seenBody = null;
  const res = await req('POST', '/explorer-api/usernode/transactions', {
    account: 'ut1a', recipient: 'ut1b', limit: 200,
  });
  assert.strictEqual(res.status, 200);
  // Addressed as <EXPLORER_API_URL>/<chain>/transactions.
  assert.strictEqual(seenUrl, 'https://ex.test/explorer-api/usernode/transactions');
  // Body forwarded verbatim.
  assert.deepStrictEqual(seenBody, { account: 'ut1a', recipient: 'ut1b', limit: 200 });
  // Upstream JSON returned through.
  assert.ok(Array.isArray(res.json.transactions));
  assert.strictEqual(res.json.transactions[0].id, 'tx-abc');
});

test('proxy is auth-exempt (no token required)', async () => {
  // The request above carried no x-usernode-token and still succeeded; assert
  // explicitly that a fresh call without auth is not 401'd.
  const res = await req('POST', '/explorer-api/usernode/transactions', { account: 'ut1a' });
  assert.notStrictEqual(res.status, 401);
  assert.strictEqual(res.status, 200);
});

test('config endpoint reports chainConfigured=true when an upstream is set', async () => {
  const res = await req('GET', '/__quickcount/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.chainConfigured, true);
  assert.strictEqual(res.json.explorerApiBase, '/explorer-api');
  assert.strictEqual(res.json.chainId, 'usernode');
});

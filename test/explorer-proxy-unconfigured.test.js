'use strict';

// Companion to explorer-proxy.test.js: loads the server with NO chain read
// source configured (neither EXPLORER_API_URL nor NODE_RPC_URL) in its own
// process, and asserts the graceful-degradation contract:
//   • /explorer-api/<chain>/transactions returns 503 (nothing to forward to)
//   • the config endpoint reports chainConfigured=false so the client confirms
//     optimistically instead of dead-ending on a 20s timeout.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Strip every chain source BEFORE requiring server.js (read at module load).
// MOCK_TX_FLOW=false selects the real-chain read path so the degradation
// contract (503 proxy + chainConfigured=false) is the behaviour under test;
// with mock mode on, chainConfigured is forced true and there is nothing to poll.
delete process.env.EXPLORER_API_URL;
delete process.env.NODE_RPC_URL;
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
process.env.MOCK_TX_FLOW = 'false';
process.env.USERNODE_ENV = 'production';

const { app } = require('../server');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (server) server.close(); });

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

test('proxy returns 503 when no chain read source is configured', async () => {
  const res = await req('POST', '/explorer-api/usernode/transactions', { account: 'ut1a' });
  assert.strictEqual(res.status, 503);
  assert.ok(Array.isArray(res.json.transactions)); // still well-formed
});

test('config reports chainConfigured=false so the client confirms optimistically', async () => {
  const res = await req('GET', '/__quickcount/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.chainConfigured, false);
});

test('public config also reports chainConfigured=false', async () => {
  const res = await req('GET', '/api/public/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.chainConfigured, false);
});

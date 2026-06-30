'use strict';

// Locks the NEW production default: real on-chain mode is what an UNSET
// MOCK_TX_FLOW yields. With the variable absent and USERNODE_ENV=production the
// app must advertise mockMode:false and the self-contained mock surface must be
// ABSENT (GET /__mock/enabled → 404), so the hosted bridge signs/broadcasts and
// the SPA catch-all can't answer the bridge's probe with a 200 index.html.
//
// Companion to config-real-mode.test.js (which sets MOCK_TX_FLOW='false'
// explicitly); here we assert the implicit default with the var deleted.
// Env is read at server.js module load, so set it BEFORE requiring the server.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

delete process.env.MOCK_TX_FLOW; // unset → real mode is the default
delete process.env.APP_MODE;
delete process.env.EXPLORER_API_URL;
delete process.env.DATABASE_URL;
process.env.NODE_RPC_URL = 'https://node.test'; // keep the deploy "configured"
process.env.USERNODE_ENV = 'production';

const { app } = require('../server');

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (server) server.close(); });

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(new URL(base + path), (res) => {
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

test('unset MOCK_TX_FLOW in production defaults to real mode (mockMode:false)', async () => {
  const cfg = await get('/__quickcount/config');
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(cfg.json.mockMode, false);

  const pub = await get('/api/public/config');
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.json.mockMode, false);
});

test('the mock surface is absent in real mode (GET /__mock/enabled → 404)', async () => {
  const res = await get('/__mock/enabled');
  assert.strictEqual(res.status, 404);
});

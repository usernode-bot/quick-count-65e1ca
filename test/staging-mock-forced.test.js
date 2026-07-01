'use strict';

// Locks the staging force-on guard: staging must NEVER broadcast or read the
// real chain, so MOCK_TX_FLOW is forced ON whenever USERNODE_ENV=staging —
// regardless of the stored flag value. Here we set MOCK_TX_FLOW='false'
// (which would mean real mode in production) and assert that staging still
// reports mockMode:true and serves the /__mock/* surface (GET /__mock/enabled
// → 200), so the seeded demo runs without a real wallet or live chain.
//
// Env is read at server.js module load, so set it BEFORE requiring the server.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.USERNODE_ENV = 'staging';
process.env.MOCK_TX_FLOW = 'false'; // explicitly false — staging must override it
delete process.env.APP_MODE;
delete process.env.EXPLORER_API_URL;
delete process.env.NODE_RPC_URL;
delete process.env.DATABASE_URL;

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

test('staging forces mock mode ON even with MOCK_TX_FLOW=false (mockMode:true)', async () => {
  const cfg = await get('/__quickcount/config');
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(cfg.json.staging, true);
  assert.strictEqual(cfg.json.mockMode, true, 'staging never reads/writes the real chain');

  const pub = await get('/api/public/config');
  assert.strictEqual(pub.json.mockMode, true);
});

test('staging serves the mock surface so the preview ingests locally (GET /__mock/enabled → 200)', async () => {
  const res = await get('/__mock/enabled');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.enabled, true);
});

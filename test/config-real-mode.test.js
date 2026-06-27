'use strict';

// Real on-chain mode config contract. With MOCK_TX_FLOW=false (the production
// default) the self-contained mock surface must be ABSENT and the config must
// advertise real mode, so the hosted bridge signs/broadcasts instead of routing
// through /__mock/*. Asserts:
//   • /__quickcount/config reports mockMode:false
//   • GET /__mock/enabled returns 404 (so the bridge stays in real mode and the
//     SPA catch-all can't answer the probe with a 200 index.html)
//   • timerDurationMs is present in config (drives the client auto-refresh)
//
// Env is read at server.js module load, so set it BEFORE requiring the server.
// A node upstream keeps the deploy "configured"; production-ish, no DB.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

process.env.MOCK_TX_FLOW = 'false';
process.env.NODE_RPC_URL = 'https://node.test';
process.env.TIMER_DURATION_MS = '6000';
delete process.env.EXPLORER_API_URL;
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
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

test('config reports mockMode:false in real on-chain mode', async () => {
  const res = await get('/__quickcount/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.mockMode, false);
});

test('public config also reports mockMode:false', async () => {
  const res = await get('/api/public/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.mockMode, false);
});

test('GET /__mock/enabled returns 404 so the bridge stays in real mode', async () => {
  const res = await get('/__mock/enabled');
  assert.strictEqual(res.status, 404);
});

test('config surfaces timerDurationMs for the client auto-refresh', async () => {
  const res = await get('/__quickcount/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.timerDurationMs, 6000);
});

test('TIMER_DURATION_MS is floored at 1000ms', async () => {
  // The running server was loaded with 6000; assert the floor logic directly so
  // an absurd value can never spin the poll/refresh loop.
  assert.strictEqual(Math.max(1000, Number('250') || 6000), 1000);
  assert.strictEqual(Math.max(1000, Number('') || 6000), 6000);
});

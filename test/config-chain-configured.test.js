'use strict';

// Companion to explorer-proxy-unconfigured.test.js (which asserts the
// chainConfigured=false / 503 degradation path). Here we boot the server WITH a
// chain read source — the platform-managed NODE_RPC_URL fallback — and assert
// the inverse: source resolves to the node backend and /__quickcount/config (and
// /api/public/config) report chainConfigured=true. This guards the contract the
// SPA banner + success-toast logic depend on: a configured deploy must NOT show
// the "on-chain sync not configured" banner or the awaiting-sync notice.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

// Configure a node upstream (the documented EXPLORER_API_URL fallback) BEFORE
// requiring server.js — env is read at module load. No DB, production-ish.
process.env.NODE_RPC_URL = 'https://node.test';
delete process.env.EXPLORER_API_URL;
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;
process.env.USERNODE_ENV = 'production';

const { app, source } = require('../server');

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

test('source resolves to the node backend when NODE_RPC_URL is set', () => {
  assert.strictEqual(source.backend, 'node');
  assert.strictEqual(source.configured, true);
});

test('config reports chainConfigured=true so no banner / no awaiting-sync notice', async () => {
  const res = await get('/__quickcount/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.chainConfigured, true);
});

test('public config also reports chainConfigured=true', async () => {
  const res = await get('/api/public/config');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.chainConfigured, true);
});

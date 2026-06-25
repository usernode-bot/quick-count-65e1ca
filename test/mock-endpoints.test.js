'use strict';

// Endpoint tests for the local-dev /__mock/* surface. These run with the
// server loaded in local-dev mode (APP_MODE set BEFORE requiring server.js, so
// LOCAL_DEV is true) and WITHOUT a database (DATABASE_URL unset → pool null).
// The "absent outside local-dev" half is covered in me-endpoints.test.js, which
// loads the same server with LOCAL_DEV false in its own process.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const memo = require('../lib/memo');

// A valid app-envelope memo — /__mock/submit now rejects undecodable memos, so
// every submit must carry one.
const MEMO = memo.encode(memo.orgMemo('Mock Endpoint Org', 'Testland'));

// Must be set before server.js is required — LOCAL_DEV is read at module load.
process.env.APP_MODE = 'local-dev';
delete process.env.DATABASE_URL;

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

test('GET /__mock/enabled returns 200 {enabled:true} in local-dev', async () => {
  const { status, json } = await req('GET', '/__mock/enabled');
  assert.strictEqual(status, 200);
  assert.strictEqual(json.enabled, true);
});

test('POST /__mock/submit succeeds without `from` (defaults the sender)', async () => {
  const { status, json } = await req('POST', '/__mock/submit', { to: 'ut1someone0000000000000000000000000000000', amount: 0, memo: MEMO });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
  assert.match(json.txId, /^mocktx_/);
  // The transaction was actually recorded in the mock ledger.
  const { json: list } = await req('GET', '/__mock/transactions');
  assert.ok(list.transactions.some((tx) => tx.txId === json.txId), 'submitted tx is in the ledger');
});

test('POST /__mock/submit still honours an explicit `from` (no JWT here)', async () => {
  const from = 'ut1explicit000000000000000000000000000000';
  const { status, json } = await req('POST', '/__mock/submit', { from, to: from, amount: 0, memo: MEMO });
  assert.strictEqual(status, 200);
  assert.strictEqual(json.ok, true);
  const { json: list } = await req('GET', '/__mock/transactions');
  assert.ok(list.transactions.some((tx) => tx.txId === json.txId && tx.from === from), 'explicit sender preserved');
});

test('POST /__mock/submit rejects an undecodable memo (400) without recording it', async () => {
  const { json: before } = await req('GET', '/__mock/transactions');
  const beforeN = before.transactions.length;
  const { status, json } = await req('POST', '/__mock/submit', { to: 'ut1x000000000000000000000000000000000000', amount: 0, memo: 'not-a-memo' });
  assert.strictEqual(status, 400);
  assert.ok(json.error, 'error reported');
  const { json: after } = await req('GET', '/__mock/transactions');
  assert.strictEqual(after.transactions.length, beforeN, 'bad memo did not poison the ledger');
});

'use strict';

// Read-path proof for real mode. With MOCK_TX_FLOW unset (real mode) and a
// configured NODE_RPC_URL, a chain ingest (triggered via GET /__quickcount/refresh
// → pollOnce) must take the REAL branch: it calls source.listTransactions, which
// fetches the configured node/explorer endpoint and ingests the returned rows —
// NOT the in-process mock ledger. We stub global.fetch (the single network call
// shared by lib/txsource.postTransactions) to return an org→treasury registration
// addressed to the watched treasury address, then assert:
//   • the stubbed endpoint was actually hit (the mock branch never calls fetch),
//   • the returned org surfaces in the event-sourced read model.
//
// Env is read at server.js module load, so set it BEFORE requiring the server.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const memo = require('../lib/memo');

delete process.env.MOCK_TX_FLOW; // unset → real mode
delete process.env.APP_MODE;
delete process.env.EXPLORER_API_URL;
delete process.env.DATABASE_URL;
process.env.NODE_RPC_URL = 'https://node.test'; // source.backend === 'node'
process.env.USERNODE_ENV = 'production';

const { app, indexer, source } = require('../server');

const TREASURY = indexer.treasury;
const FEE = indexer.orgFee;
const ORG = 'ut1realreadpathorg00000000000000000000000';

// The single org→treasury registration the stubbed chain endpoint reports.
const CHAIN_TX = {
  txId: 'realtx_readpath_0001',
  from: ORG,
  to: TREASURY,
  amount: FEE,
  memo: memo.encode(memo.orgMemo('Real Read Path Org', 'Testland')),
  created_at: '2026-06-30T12:00:00.000Z',
};

let fetchCalls = 0;
let server, base;
const realFetch = global.fetch;
before(async () => {
  // Stub the network so postTransactions() returns our chain row for any query.
  global.fetch = async () => ({
    status: 200,
    ok: true,
    json: async () => ({ transactions: [CHAIN_TX] }),
  });
  // Count calls without losing the stub's behaviour.
  const stub = global.fetch;
  global.fetch = async (...args) => { fetchCalls++; return stub(...args); };

  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => {
  global.fetch = realFetch;
  if (server) server.close();
});

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

test('real mode resolves the node backend and reports mockMode:false', async () => {
  assert.strictEqual(source.backend, 'node');
  const cfg = await get('/__quickcount/config');
  assert.strictEqual(cfg.json.mockMode, false);
});

test('pollOnce reads the configured chain source and ingests the returned rows', async () => {
  const before = fetchCalls;
  const r = await get('/__quickcount/refresh'); // GET → pollOnce()
  assert.strictEqual(r.status, 200);
  assert.ok(fetchCalls > before, 'real-mode pollOnce hit the chain endpoint (mock branch never fetches)');

  // The org returned by the stubbed chain read is now in the read model.
  const row = indexer.orgs.get(ORG);
  assert.ok(row, 'org from the chain read was ingested');
  assert.strictEqual(row.name, 'Real Read Path Org');

  const orgs = await get('/__quickcount/orgs?viewer=' + encodeURIComponent(ORG));
  const mine = (orgs.json.orgs || []).find((o) => o.addr === ORG);
  assert.ok(mine, 'chain-read org surfaces in the owner view');
  assert.strictEqual(mine.active, true, 'fee paid to treasury → active');
});

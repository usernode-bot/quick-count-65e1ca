'use strict';

// Always-on local-ingest ("mock") transaction flow. Loads the server in a
// production-like environment (no APP_MODE, no chain URLs) with MOCK_TX_FLOW at
// its default (on), and asserts that a submission posted to /__mock/submit is
// ingested into the event-sourced read model immediately — orgs appear in
// /__quickcount/orgs with NO chain read-back, deduped by txId, and the config
// endpoints advertise mockMode. Also verifies the authenticated wallet (req.user)
// wins over a spoofed body `from`.

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const memo = require('../lib/memo');

// Production-like: no local-dev, no chain source. JWT_SECRET lets us mint a token
// the auth middleware verifies into req.user. All set BEFORE requiring server.js.
process.env.JWT_SECRET = 'test-secret-mock-tx-flow';
process.env.USERNODE_ENV = 'production';
delete process.env.APP_MODE;
delete process.env.EXPLORER_API_URL;
delete process.env.NODE_RPC_URL;
delete process.env.DATABASE_URL;
delete process.env.MOCK_TX_FLOW; // default → on

const { app, indexer } = require('../server');

const TREASURY = indexer.treasury;
const FEE = indexer.orgFee;

let server, base;
before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port;
});
after(() => { if (server) server.close(); });

function req(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const u = new URL(base + path);
    const r = http.request(u, {
      method,
      headers: Object.assign(data ? { 'Content-Type': 'application/json' } : {}, headers || {}),
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

test('config endpoints advertise mockMode and a truthy chainConfigured', async () => {
  const cfg = await req('GET', '/__quickcount/config');
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(cfg.json.mockMode, true);
  assert.strictEqual(cfg.json.chainConfigured, true, 'no banner / no awaiting-sync in mock mode');

  const pub = await req('GET', '/api/public/config');
  assert.strictEqual(pub.json.mockMode, true);
  assert.strictEqual(pub.json.chainConfigured, true);
});

test('an org submitted to /__mock/submit is ingested and surfaces as an active org', async () => {
  const ORG = 'ut1mockfloworg00000000000000000000000000';
  const m = memo.encode(memo.orgMemo('Mock Flow Org', 'Testland'));
  const r = await req('POST', '/__mock/submit', { from: ORG, to: TREASURY, amount: FEE, memo: m });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.ok, true);

  // No chain poll, no waiting — the read model already reflects it.
  const orgs = await req('GET', '/__quickcount/orgs?viewer=' + encodeURIComponent(ORG));
  assert.strictEqual(orgs.status, 200);
  const mine = (orgs.json.orgs || []).find((o) => o.addr === ORG);
  assert.ok(mine, 'submitted org appears in the owner view');
  assert.strictEqual(mine.viewerRole, 'owner');
  assert.strictEqual(mine.active, true, 'fee paid to treasury → active');

  const row = indexer.orgs.get(ORG);
  assert.ok(row && row.name === 'Mock Flow Org');
});

test('the authenticated wallet (req.user) overrides a spoofed body `from`', async () => {
  const REAL = 'ut1realwalletfromjwt0000000000000000000000';
  const SPOOF = 'ut1attackerspoofedfrom00000000000000000000';
  const token = jwt.sign({ id: 1, username: 'real', usernode_pubkey: REAL }, process.env.JWT_SECRET);
  const m = memo.encode(memo.orgMemo('JWT Owned Org', 'Testland'));

  const r = await req('POST', '/__mock/submit',
    { from: SPOOF, to: TREASURY, amount: FEE, memo: m },
    { 'x-usernode-token': token });
  assert.strictEqual(r.status, 200);

  // The org is owned by the JWT wallet, not the spoofed sender.
  assert.ok(indexer.orgs.get(REAL), 'org owned by the authenticated wallet');
  assert.strictEqual(indexer.orgs.get(SPOOF), undefined, 'spoofed sender ignored');

  const ledger = await req('GET', '/__mock/transactions');
  const tx = ledger.json.transactions.find((t) => t.txId === r.json.txId);
  assert.strictEqual(tx.from, REAL, 'ledger records the authenticated wallet as from');
});

test('a replay (extra pollOnce via /__quickcount/refresh) is a no-op — deduped by txId', async () => {
  const ORG = 'ut1mockflowdedupe000000000000000000000000';
  const m = memo.encode(memo.orgMemo('Dedupe Org', 'Testland'));
  await req('POST', '/__mock/submit', { from: ORG, to: TREASURY, amount: FEE, memo: m });

  const countBefore = indexer.orgs.size;
  await req('GET', '/__quickcount/refresh'); // replays the whole mock ledger
  await req('GET', '/__quickcount/refresh');
  assert.strictEqual(indexer.orgs.size, countBefore, 'no duplicate orgs after re-ingest');
});

test('an undecodable memo is rejected (400) and does not change state', async () => {
  const sizeBefore = indexer.orgs.size;
  const r = await req('POST', '/__mock/submit', { from: 'ut1x000000000000000000000000000000000000', to: TREASURY, amount: FEE, memo: 'garbage' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(indexer.orgs.size, sizeBefore, 'state unchanged by a bad memo');
});

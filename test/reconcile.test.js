'use strict';

// Integration test for the resync/reconcile path: re-listing the transaction log
// through the explorer backend and replaying it reconstructs byte-for-byte the
// same read state as a direct rebuild. This proves the cache (in-memory txLog +
// the chain_txs table) is DISPOSABLE — drop it, re-read from chain, recover.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

// Keep server.js DB-free (pool null) and out of staging while requiring it.
delete process.env.DATABASE_URL;
delete process.env.USERNODE_ENV;

const { QuickCountIndexer, normalizeTx } = require('../lib/indexer');
const { makeSource } = require('../lib/txsource');
const { buildDemoTxs } = require('../server');

const CFG = { treasury: 'ut1treasuryquickcount00000000000000000000', orgFee: 100, adminAddrs: [] };

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

// Rename a normalized tx into an explorer-shaped raw row (different field names)
// so the test exercises normalizeTx's variant mapping on the explorer path.
function toExplorerRow(n) {
  return { tx_hash: n.txId, sender: n.from, recipient: n.to, amount: n.amount, memo: n.memo, created_at: n.createdAt };
}

function summarize(indexer) {
  const visible = indexer.visibleElections({ viewer: null, admin: false });
  const summaries = visible.map((el) => indexer.electionSummary(el));
  const detail = indexer.electionDetail('demo-election', 'latest');
  return JSON.stringify({ summaries, detail });
}

test('explorer-sourced replay reconstructs the same state as the direct log', async () => {
  const demo = buildDemoTxs(); // canonical normalized transaction log

  // 1) Direct rebuild — as if loaded straight from the chain_txs cache.
  const direct = new QuickCountIndexer(CFG);
  direct.rebuild(demo.map(normalizeTx));
  const directState = summarize(direct);
  assert.ok(JSON.parse(directState).summaries.length >= 1, 'demo election is present');

  // 2) Truncate the cache and re-read the SAME txs through the explorer backend,
  //    re-normalize, and rebuild a fresh indexer.
  global.fetch = async () => ({ ok: true, json: async () => ({ transactions: demo.map(toExplorerRow) }) });
  const src = makeSource({ localDev: false, explorerUrl: 'https://ex.test/explorer-api', chainId: 'usernode' });
  assert.strictEqual(src.backend, 'explorer');
  const raw = await src.listTransactions({ account: CFG.treasury });
  const resynced = new QuickCountIndexer(CFG);
  resynced.rebuild(raw.map(normalizeTx));
  const resyncedState = summarize(resynced);

  assert.strictEqual(resyncedState, directState, 'resync from chain == direct rebuild');
});

test('treasury poll surfaces recipient-side (user -> treasury) registrations', async () => {
  // An org registration is a user -> treasury transfer. The poller watches the
  // treasury, so the explorer query MUST return transactions where the treasury
  // is the RECIPIENT, not only the sender. Model an explorer that ANDs whichever
  // of { account, recipient } are present (the strict interpretation): a single
  // { account: treasury, recipient: treasury } body would match only self-sends
  // and miss the registration. listFromBase now queries each side separately.
  const reg = {
    tx_hash: 'reg-1', sender: 'ut1someorg', recipient: CFG.treasury,
    amount: CFG.orgFee, memo: require('../lib/memo').encode(require('../lib/memo').orgMemo('Recipient-side Org', 'Land')),
    created_at: '2026-06-20T09:00:00.000Z',
  };
  global.fetch = async (_url, opts) => {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch (_) {}
    const hasAcct = body.account != null;
    const hasRcpt = body.recipient != null;
    const match = [reg].filter((tx) => {
      if (hasAcct && tx.sender !== body.account) return false;
      if (hasRcpt && tx.recipient !== body.recipient) return false;
      return hasAcct || hasRcpt;
    });
    return { ok: true, status: 200, json: async () => ({ transactions: match }) };
  };
  const src = makeSource({ localDev: false, explorerUrl: 'https://ex.test/explorer-api', chainId: 'usernode' });
  const raw = await src.listTransactions({ account: CFG.treasury });
  assert.ok(raw.some((r) => r.tx_hash === 'reg-1'), 'registration surfaced via the recipient-side query');

  const ix = new QuickCountIndexer(CFG);
  ix.rebuild(raw.map(normalizeTx));
  assert.ok(ix.activeOrgs().some((o) => o.addr === 'ut1someorg'), 'recipient-side registration becomes an active org');
});

test('replay is idempotent — ingesting the log twice yields identical state', () => {
  const demo = buildDemoTxs().map(normalizeTx);
  const once = new QuickCountIndexer(CFG); once.rebuild(demo);
  const twice = new QuickCountIndexer(CFG); twice.rebuild(demo.concat(demo));
  assert.strictEqual(summarize(twice), summarize(once));
});

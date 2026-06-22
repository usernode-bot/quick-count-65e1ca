'use strict';

// Tests for the explorer-proxy read backend in lib/txsource.js. The explorer is
// the canonical source; NODE_RPC_URL is the standalone fallback. global.fetch is
// stubbed per-test and restored afterwards.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');

// IS_STAGING is captured at module load — ensure we are NOT in staging so
// getTransaction actually reaches the (stubbed) explorer.
delete process.env.USERNODE_ENV;

const { makeSource, getTransaction, explorerTxUrl } = require('../lib/txsource');

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

test('explorerTxUrl builds <base>/<chain>/transactions and trims slashes', () => {
  assert.strictEqual(explorerTxUrl('https://ex.test/explorer-api', 'usernode'),
    'https://ex.test/explorer-api/usernode/transactions');
  assert.strictEqual(explorerTxUrl('https://ex.test/explorer-api/', 'usernode'),
    'https://ex.test/explorer-api/usernode/transactions');
  assert.strictEqual(explorerTxUrl('', 'usernode'), null);
  assert.strictEqual(explorerTxUrl('https://ex.test', ''), null);
});

test('makeSource prefers the explorer backend and queries the per-chain endpoint', async () => {
  let seenUrl = null, seenBody = null;
  global.fetch = async (url, opts) => {
    seenUrl = url; seenBody = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ transactions: [{ tx_hash: 't1', sender: 'a', recipient: 'b', memo: 'm', amount: 0, created_at: '2026-01-01T00:00:00Z' }] }) };
  };
  const src = makeSource({ localDev: false, nodeUrl: 'https://node.test', explorerUrl: 'https://ex.test/explorer-api', chainId: 'usernode' });
  assert.strictEqual(src.backend, 'explorer');
  const txs = await src.listTransactions({ account: 'a' });
  assert.strictEqual(seenUrl, 'https://ex.test/explorer-api/usernode/transactions');
  assert.strictEqual(seenBody.account, 'a');
  assert.strictEqual(txs.length, 1);
  assert.strictEqual(txs[0].tx_hash, 't1');
});

test('makeSource falls back to NODE_RPC_URL when no explorer is configured', async () => {
  let seenUrl = null;
  global.fetch = async (url) => { seenUrl = url; return { ok: true, json: async () => [] }; };
  const src = makeSource({ localDev: false, nodeUrl: 'https://node.test' });
  assert.strictEqual(src.backend, 'node');
  await src.listTransactions({ account: 'a' });
  assert.strictEqual(seenUrl, 'https://node.test/transactions');
});

test('makeSource reports backend "none" and returns [] when nothing is configured', async () => {
  const src = makeSource({ localDev: false });
  assert.strictEqual(src.backend, 'none');
  assert.deepStrictEqual(await src.listTransactions({ account: 'a' }), []);
});

test('makeSource never throws out of the poll loop on a failing source', async () => {
  global.fetch = async () => { throw new Error('boom'); };
  const src = makeSource({ localDev: false, explorerUrl: 'https://ex.test/explorer-api', chainId: 'c' });
  assert.deepStrictEqual(await src.listTransactions({ account: 'a' }), []);
});

test('getTransaction matches an id from the explorer endpoint', async () => {
  process.env.EXPLORER_API_URL = 'https://ex.test/explorer-api';
  process.env.CHAIN_ID = 'usernode';
  let seenUrl = null;
  global.fetch = async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ transactions: [{ tx_id: 'want', recipient: 'r' }, { tx_id: 'other' }] }) };
  };
  const raw = await getTransaction({ txId: 'want', recipient: 'r' });
  assert.ok(raw, 'found the transaction');
  assert.strictEqual(raw.tx_id, 'want');
  assert.strictEqual(seenUrl, 'https://ex.test/explorer-api/usernode/transactions');
  delete process.env.EXPLORER_API_URL;
  delete process.env.CHAIN_ID;
});

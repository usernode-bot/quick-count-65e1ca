'use strict';

// End-to-end ingest test for the "registered orgs never appear / admin stats
// stuck at 0" bug. With a chain read source configured, a brand-new org
// registration (a user -> treasury transfer) must be read back by the poller,
// applied by the indexer, and surface in activeOrgs() / the admin stat counts.
//
// The explorer stub models the STRICT interpretation of a { account, recipient }
// query — it ANDs whichever fields are present (sender AND recipient). Under that
// interpretation the old single-body query ({ account: treasury, recipient:
// treasury }) matched only treasury self-sends and dropped every registration.
// listFromBase now issues two single-sided queries (by sender, by recipient) and
// concatenates, so the recipient-side registration is surfaced. This test fails
// against the old code and passes against the fix.

const { test, before, after } = require('node:test');
const assert = require('node:assert');

// Configure a chain read source BEFORE requiring server.js (env read at load).
// MOCK_TX_FLOW=false selects the real-chain read-back path this test exercises
// (the default mock flow ingests via /__mock/submit and ignores the explorer).
process.env.EXPLORER_API_URL = 'https://ex.test/explorer-api';
process.env.CHAIN_ID = 'usernode';
process.env.USERNODE_ENV = 'production';
process.env.MOCK_TX_FLOW = 'false';
delete process.env.NODE_RPC_URL;
delete process.env.APP_MODE;
delete process.env.DATABASE_URL;

const memo = require('../lib/memo');
const { indexer, resyncFromChain } = require('../server');

const TREASURY = indexer.treasury;
const FEE = indexer.orgFee;
const ORG_ADDR = 'ut1realregisteredorg00000000000000000000';

// One on-chain registration: ORG_ADDR paid the fee to the treasury. Explorer
// field-name variant (tx_hash/sender/recipient/created_at) so normalizeTx's
// mapping is exercised on the real read path.
const REG_TX = {
  tx_hash: 'usertx_registration_1',
  sender: ORG_ADDR,
  recipient: TREASURY,
  amount: FEE,
  memo: memo.encode(memo.orgMemo('Real Registered Org', 'Demoland')),
  created_at: '2026-06-20T08:00:00.000Z',
};

const realFetch = global.fetch;
before(() => {
  // Explorer with AND-of-present-fields semantics (the worst case for the poller).
  global.fetch = async (_url, opts) => {
    let body = {};
    try { body = JSON.parse(opts.body || '{}'); } catch (_) {}
    const hasAcct = body.account != null;
    const hasRcpt = body.recipient != null;
    const match = [REG_TX].filter((tx) => {
      if (hasAcct && tx.sender !== body.account) return false;
      if (hasRcpt && tx.recipient !== body.recipient) return false;
      return hasAcct || hasRcpt;
    });
    return { ok: true, status: 200, json: async () => ({ transactions: match }) };
  };
});
after(() => { global.fetch = realFetch; });

test('a user->treasury registration is ingested and surfaces in activeOrgs + admin stats', async () => {
  await resyncFromChain();

  const active = indexer.activeOrgs();
  assert.ok(active.some((o) => o.addr === ORG_ADDR), 'registered org appears in activeOrgs()');

  const org = indexer.orgs.get(ORG_ADDR);
  assert.ok(org, 'org row exists in the indexer');
  assert.strictEqual(org.active, true, 'org is active (fee paid to treasury)');
  assert.strictEqual(org.name, 'Real Registered Org');

  // Admin stat counts (the same numbers /__quickcount/admin reports) are no longer 0.
  const allOrgs = indexer.allOrgs();
  assert.ok(allOrgs.length >= 1, 'admin total-orgs stat is non-zero');
  assert.ok(allOrgs.filter((o) => o.active).length >= 1, 'admin active-orgs stat is non-zero');
});

// Quick Count — transaction source adapter.
//
// Single boundary that knows how to list on-chain transactions for an address.
// Two backends:
//   • local-dev  → the in-process mock ledger (lib/mockledger.js)
//   • production → the Usernode node at NODE_RPC_URL
//
//   listTransactions({ account, sinceCursor }) -> array of raw transactions

const mock = require('./mockledger');

function makeSource({ localDev, nodeUrl } = {}) {
  async function listTransactions({ account, sinceCursor } = {}) {
    if (localDev) {
      // The mock ledger holds every tx; the poller dedupes against its log, so
      // returning the full set (ignoring the per-address cursor) is fine.
      return mock.all();
    }
    const base = nodeUrl;
    if (!base || !account) return [];
    const url = base.replace(/\/+$/, '') + '/transactions';
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account, recipient: account, since: sinceCursor || undefined, limit: 500 }),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      if (Array.isArray(data)) return data;
      return data.transactions || data.txs || data.results || [];
    } catch {
      // Never throw out of the poll loop — a transient node error just retries.
      return [];
    }
  }
  return { listTransactions };
}

module.exports = { makeSource };

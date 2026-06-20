// Quick Count — transaction source adapter.
//
// Single boundary that knows how to list on-chain transactions for an address.
// The exact node/explorer request+response shape lives only here, isolated
// from the rest of the app.
//
//   listTransactions({ account, sinceCursor }) -> array of raw transactions
//
// In staging/local there is no live chain to poll, so this is a deliberate
// no-op and the read model is populated by the IS_STAGING boot seed instead.
// In production it targets the platform node via NODE_RPC_URL.

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

async function listTransactions({ account, sinceCursor } = {}) {
  if (IS_STAGING) return [];
  const base = process.env.NODE_RPC_URL;
  if (!base || !account) return [];
  const url = base.replace(/\/+$/, '') + '/transactions';
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        account,
        recipient: account,
        since: sinceCursor || undefined,
        limit: 200,
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json();
    if (Array.isArray(data)) return data;
    return data.transactions || data.txs || data.results || [];
  } catch {
    // Never throw out of the indexer poll loop — a transient node error just
    // means we retry on the next tick.
    return [];
  }
}

// Fetch a single transaction by id, addressed to `recipient`, from the node.
// Used by the pay-to-unlock verifier to independently confirm a payment rather
// than trusting the client's claim. Returns the raw transaction or null.
// No-op in staging / when NODE_RPC_URL is unset, exactly like listTransactions.
async function getTransaction({ txId, recipient } = {}) {
  if (IS_STAGING) return null;
  if (!txId) return null;
  const base = process.env.NODE_RPC_URL;
  if (!base) return null;
  const url = base.replace(/\/+$/, '') + '/transactions';
  const idKeys = ['id', 'txid', 'txId', 'tx_id', 'hash', 'tx_hash', 'txHash'];
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: recipient, recipient, limit: 200 }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const list = Array.isArray(data) ? data : (data.transactions || data.txs || data.results || []);
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      for (const k of idKeys) {
        if (typeof raw[k] === 'string' && raw[k].trim() === txId) return raw;
      }
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = { listTransactions, getTransaction, IS_STAGING };

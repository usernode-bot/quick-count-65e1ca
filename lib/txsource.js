// Quick Count — transaction source adapter.
//
// Single boundary that knows how to list on-chain transactions for an address.
// Backends, in priority order:
//   • local-dev    → the in-process mock ledger (lib/mockledger.js)
//   • explorer     → the public block explorer at EXPLORER_API_URL, addressed
//                    per-chain as <base>/<chain_id>/transactions. This is the
//                    CANONICAL read source — the same passthrough the hosted
//                    bridge polls for inclusion (see PUBLIC_PREFIXES).
//   • node (fallback) → the Usernode node at NODE_RPC_URL, used only when no
//                    explorer base is configured (standalone deploys).
//
//   listTransactions({ account, sinceCursor }) -> array of raw transactions
//
// Either backend returns the same loosely-typed transaction shape; the indexer's
// normalizeTx() maps the field-name variants, so callers never branch on source.

const mock = require('./mockledger');

// Normalize a loosely-typed upstream response into a transaction array.
function txArrayFrom(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return data.transactions || data.txs || data.results || [];
  return [];
}

// POST a /transactions query to `url` and return the RAW upstream response as
// { status, data }. Never throws — a transient network failure yields a 502
// with null data. This is the single fetch implementation shared by the
// server-side poller (via listFromBase) and the browser-facing /explorer-api
// proxy (via the route in server.js), so both speak to the chain identically.
async function postTransactions(url, body) {
  if (!url) return { status: 503, data: null };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await resp.json().catch(() => null);
    return { status: resp.status, data };
  } catch {
    return { status: 502, data: null };
  }
}

// POST the node/explorer's /transactions query for one account. Returns an
// array (possibly empty) and NEVER throws — a transient error just yields [].
//
// The poller watches the treasury address, and an org registration is a
// user -> treasury transfer, so we MUST surface transactions where the watched
// address is the RECIPIENT, not only the sender. Explorers disagree on how a
// single body shaped like { account, recipient } is interpreted — some OR the
// fields ("involves either address"), some AND them ("sender AND recipient",
// which matches only self-sends and would drop every registration). To be
// correct under both interpretations we issue two single-sided queries — once
// by sender (`account`) and once by `recipient` — and concatenate. The caller
// (server.js ingestRaw / the indexer) dedupes by txId, so any overlap is free.
async function listFromBase(url, { account, sinceCursor } = {}) {
  if (!url || !account) return [];
  const since = sinceCursor || undefined;
  const [bySender, byRecipient] = await Promise.all([
    postTransactions(url, { account, since, limit: 500 }),
    postTransactions(url, { recipient: account, since, limit: 500 }),
  ]);
  // Treat a missing/non-error status as success (mirrors the original >= 400
  // guard), so a transient error on one side never drops the other side's rows.
  const out = [];
  if (!(bySender.status >= 400)) out.push(...txArrayFrom(bySender.data));
  if (!(byRecipient.status >= 400)) out.push(...txArrayFrom(byRecipient.data));
  return out;
}

// Build the explorer per-chain transactions endpoint, or null when unconfigured.
function explorerTxUrl(explorerUrl, chainId) {
  if (!explorerUrl || !chainId) return null;
  return explorerUrl.replace(/\/+$/, '') + '/' + encodeURIComponent(chainId) + '/transactions';
}

// Resolve the upstream /transactions endpoint for a chain, preferring the
// explorer base (canonical) and falling back to the node RPC url. Returns null
// when neither is configured. Shared by makeSource() and the /explorer-api proxy.
function resolveTxEndpoint({ explorerUrl, nodeUrl, chainId } = {}) {
  return explorerTxUrl(explorerUrl, chainId)
    || (nodeUrl ? nodeUrl.replace(/\/+$/, '') + '/transactions' : null);
}

function makeSource({ localDev, nodeUrl, explorerUrl, chainId } = {}) {
  const explorerEndpoint = explorerTxUrl(explorerUrl, chainId);
  const nodeEndpoint = nodeUrl ? nodeUrl.replace(/\/+$/, '') + '/transactions' : null;
  // Canonical source is the explorer; the node URL is a standalone fallback.
  const endpoint = explorerEndpoint || nodeEndpoint;
  // True when this app can actually read the chain — drives the boot warning
  // and the client's chainConfigured signal (optimistic confirm when false).
  const configured = localDev || !!endpoint;

  async function listTransactions({ account, sinceCursor } = {}) {
    if (localDev) {
      // The mock ledger holds every tx; the poller dedupes against its log, so
      // returning the full set (ignoring the per-address cursor) is fine.
      return mock.all();
    }
    return listFromBase(endpoint, { account, sinceCursor });
  }

  return {
    listTransactions,
    // Surfaced for boot-time logging / diagnostics.
    backend: localDev ? 'mock' : (explorerEndpoint ? 'explorer' : (nodeEndpoint ? 'node' : 'none')),
    endpoint,
    configured,
  };
}

const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Fetch a single transaction by id, addressed to `recipient`, from the chain.
// Used by the pay-to-unlock verifier to independently confirm a payment rather
// than trusting the client's claim. Returns the raw transaction or null.
// Prefers the explorer proxy (canonical); falls back to NODE_RPC_URL.
// No-op in staging / when neither source is configured, like listTransactions.
async function getTransaction({ txId, recipient } = {}) {
  if (IS_STAGING) return null;
  if (!txId) return null;
  const url = explorerTxUrl(process.env.EXPLORER_API_URL, process.env.CHAIN_ID)
    || (process.env.NODE_RPC_URL ? process.env.NODE_RPC_URL.replace(/\/+$/, '') + '/transactions' : null);
  if (!url) return null;
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

module.exports = { makeSource, getTransaction, explorerTxUrl, resolveTxEndpoint, postTransactions, txArrayFrom };

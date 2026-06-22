// Quick Count — pure helpers for the client confirmation poll.
//
// confirmTx() in public/index.html (and public/dashboard.html) polls the public
// explorer proxy after a send and waits for the transaction id to appear on the
// ledger. The matching logic is mirrored inline in the browser (no bundler), and
// lives here too so it is unit-testable in Node. Field-name variants match
// lib/indexer.normalizeTx() and the resilience layer's extractTxId().

const ID_KEYS = ['id', 'txid', 'txId', 'tx_id', 'hash', 'tx_hash', 'txHash'];

// Extract the transaction id from a raw explorer/node row, trying each variant.
function txIdOf(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const k of ID_KEYS) {
    if (typeof raw[k] === 'string' && raw[k].trim()) return raw[k].trim();
  }
  return null;
}

// Normalize the loosely-typed explorer/node response into a transaction array.
function txArray(data) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') return data.transactions || data.txs || data.results || [];
  return [];
}

// True when any tx in `list` carries the given id. `list` may be a raw response
// object or an already-extracted array; a missing id never matches.
function matchTxInList(list, txId) {
  if (!txId) return false;
  const arr = Array.isArray(list) ? list : txArray(list);
  for (const raw of arr) {
    if (txIdOf(raw) === txId) return true;
  }
  return false;
}

module.exports = { ID_KEYS, txIdOf, txArray, matchTxInList };

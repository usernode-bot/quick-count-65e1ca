// Quick Count — in-memory mock ledger (local-dev only).
//
// Stands in for a real chain when running with --local-dev / no NODE_RPC_URL.
// The mock wallet bridge POSTs signed transactions here; the indexer poller
// reads them back. Process-local and ephemeral — never used in production.

let txs = [];
let counter = 0;

function nextId() {
  counter += 1;
  return 'mocktx_' + String(counter).padStart(6, '0');
}

// Append a transaction. `at` / `createdAt` lets seed data backdate rows
// deterministically (preserving replay order).
function append({ from, to, amount, memo, at, createdAt, txId } = {}) {
  const tx = {
    txId: txId || nextId(),
    from: from || null,
    to: to || null,
    amount: Number(amount) || 0,
    memo: memo == null ? null : String(memo),
    createdAt: at || createdAt || new Date().toISOString(),
  };
  txs.push(tx);
  return tx;
}

function all() {
  return txs.slice();
}

function reset() {
  txs = [];
  counter = 0;
}

function size() {
  return txs.length;
}

module.exports = { append, all, reset, size, nextId };

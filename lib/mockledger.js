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

// Advance the auto-increment counter past an already-known `mocktx_NNNNNN` id.
//
// The mock ledger is process-local and ephemeral, but the ids it mints are
// PERSISTED to `chain_txs` (and replayed into the indexer's `seen` set on boot,
// and COPIED into every staging container's DB). After a restart/redeploy the
// in-memory counter resets to 0, so the next `nextId()` would regenerate
// `mocktx_000001`, `mocktx_000002`, … — ids the indexer has already seen, which
// `ingestRaw` then silently drops as duplicates. The freshly created org/election
// would never get indexed ("nothing appears in the list", and it doesn't survive
// a refresh). Calling noteId() for every id loaded from / ingested into the log
// keeps the counter ahead of anything already known, so new ids never collide.
function noteId(txId) {
  if (typeof txId !== 'string') return;
  const m = /^mocktx_(\d+)$/.exec(txId);
  if (!m) return;
  const n = parseInt(m[1], 10);
  if (Number.isFinite(n) && n > counter) counter = n;
}

// Append a transaction. `at` / `createdAt` lets seed data backdate rows
// deterministically (preserving replay order).
function append({ from, to, amount, memo, at, createdAt, txId } = {}) {
  // An explicit id (seed / backdated row) may itself be a mocktx_NNNNNN value —
  // keep the counter ahead of it so a later auto-minted id can't collide.
  if (txId) noteId(txId);
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

module.exports = { append, all, reset, size, nextId, noteId };

// Quick Count — transaction indexer.
//
// Pure-ish logic that reconstructs the read model from on-chain transactions.
// `applyTx` talks to an abstract `store` (PgStore in production, an in-memory
// store in tests) so the same code path is exercised either way. All store
// writes are insert-if-absent, so replaying the same tx_id is a no-op
// (idempotency).

const { decode } = require('./memo');

function pickFirst(o, keys) {
  for (const k of keys) if (o[k] != null) return o[k];
  return null;
}

// Normalize the many transaction field-name variants the bridge/explorer may
// use into a single shape: { txId, from, to, memo, amount, createdAt(ISO) }.
function normalizeTx(raw) {
  if (!raw || typeof raw !== 'object') return {};
  let txId = null;
  for (const v of [raw.id, raw.txid, raw.txId, raw.tx_id, raw.hash, raw.tx_hash, raw.txHash]) {
    if (typeof v === 'string' && v.trim()) { txId = v.trim(); break; }
  }
  const from = pickFirst(raw, ['from_pubkey', 'sender', 'account', 'from']);
  const to = pickFirst(raw, ['destination_pubkey', 'destination', 'to', 'recipient']);
  const memo = raw.memo == null ? null : String(raw.memo);
  const createdRaw = pickFirst(raw, ['created_at', 'createdAt', 'timestamp', 'time']);
  let createdAt = null;
  if (createdRaw != null) {
    const d = typeof createdRaw === 'number' ? new Date(createdRaw) : new Date(String(createdRaw));
    if (!Number.isNaN(d.getTime())) createdAt = d.toISOString();
  }
  return {
    txId,
    from: from == null ? null : String(from),
    to: to == null ? null : String(to),
    memo,
    amount: raw.amount,
    createdAt,
  };
}

// Apply a single normalized transaction to the store. Returns a small result
// object describing what happened (used by tests + logging).
async function applyTx(store, tx) {
  if (!tx || !tx.txId) return { applied: false, reason: 'no-txid' };
  const env = decode(tx.memo);
  if (!env) return { applied: false, reason: 'bad-memo' };
  const createdAt = tx.createdAt || null;

  if (env.t === 'el') {
    await store.putElection({
      eid: tx.txId,
      name: env.name || 'Untitled election',
      root_pubkey: tx.to || tx.from,
      creator_pubkey: tx.from,
      tx_id: tx.txId,
      created_at: createdAt,
    });
    return { applied: true, kind: 'el', eid: tx.txId };
  }

  if (env.t === 'cand' || env.t === 'stn') {
    const el = await store.getElection(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    // Structural txs must come from the election creator (authorization).
    if (el.creator_pubkey && tx.from && el.creator_pubkey !== tx.from) {
      return { applied: false, reason: 'unauthorized' };
    }
    if (env.t === 'cand') {
      if (!Number.isInteger(env.cid)) return { applied: false, reason: 'bad-cid' };
      await store.putCandidate({ eid: env.eid, cid: env.cid, name: env.name || ('Candidate ' + env.cid), tx_id: tx.txId });
      return { applied: true, kind: 'cand' };
    }
    if (!Number.isInteger(env.sid)) return { applied: false, reason: 'bad-sid' };
    await store.putStation({ eid: env.eid, sid: env.sid, name: env.name || ('Station ' + env.sid), tx_id: tx.txId });
    return { applied: true, kind: 'stn' };
  }

  if (env.t === 'res') {
    const el = await store.getElection(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    if (!Number.isInteger(env.sid)) return { applied: false, reason: 'bad-sid' };
    // Results are accepted from ANY sender in slice 1 (agent-assignment
    // enforcement is deferred). Submitter pubkey is recorded.
    const votes = env.votes && typeof env.votes === 'object' ? env.votes : {};
    await store.putResult({
      tx_id: tx.txId,
      eid: env.eid,
      sid: env.sid,
      submitter_pubkey: tx.from,
      votes,
      tot: env.tot == null ? null : env.tot,
      inv: env.inv == null ? null : env.inv,
      created_at: createdAt,
    });
    return { applied: true, kind: 'res' };
  }

  return { applied: false, reason: 'unknown-type' };
}

module.exports = { normalizeTx, applyTx };

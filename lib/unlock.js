// Quick Count — pay-to-unlock payment verification (v1).
//
// Pure functions so the verification logic can be unit-tested without a DB or
// a live chain (mirrors lib/indexer.js / lib/aggregate.js). An unlock payment
// is an ordinary on-chain transfer to a configured recipient whose memo
// carries a small `{ v:1, t:'unlock' }` envelope. The indexer's memo decoder
// (lib/memo.js) only accepts el|cand|stn|res, so this memo is ignored by the
// results indexer and never pollutes the read model.
//
// NOTE: the network is currently a test/mock token network — there is nothing
// test-specific in this logic. Transitioning to mainnet is purely a matter of
// pointing UNLOCK_RECIPIENT_ADDRESS at a real wallet; this verifier is unchanged.

const UNLOCK_V = 1;

// Canonical unlock memo string sent with the payment transaction.
function unlockMemo() {
  return JSON.stringify({ v: UNLOCK_V, t: 'unlock' });
}

// True when a memo string is a well-formed v1 unlock envelope.
function isUnlockMemo(str) {
  if (typeof str !== 'string' || !str) return false;
  let o;
  try { o = JSON.parse(str); } catch { return false; }
  return !!o && typeof o === 'object' && !Array.isArray(o) && o.v === UNLOCK_V && o.t === 'unlock';
}

// Verify a (normalized) transaction is a valid unlock payment.
//   tx        — { txId, from, to, amount, memo } (see lib/indexer.normalizeTx)
//   recipient — configured UNLOCK_RECIPIENT_ADDRESS
//   price     — configured UNLOCK_PRICE_TOKENS (integer minimum)
//   sender    — the caller's usernode_pubkey (must match tx.from)
// Returns { ok: true } or { ok: false, reason }.
function verifyPayment(tx, { recipient, price, sender } = {}) {
  if (!tx || typeof tx !== 'object' || !tx.txId) return { ok: false, reason: 'tx-not-found' };
  if (!recipient) return { ok: false, reason: 'no-recipient-configured' };
  if (!sender) return { ok: false, reason: 'no-sender' };
  if (tx.to !== recipient) return { ok: false, reason: 'wrong-recipient' };
  if (tx.from !== sender) return { ok: false, reason: 'wrong-sender' };
  const amt = Number(tx.amount);
  const min = Number(price);
  if (!Number.isFinite(amt) || !Number.isFinite(min) || amt < min) return { ok: false, reason: 'insufficient-amount' };
  if (!isUnlockMemo(tx.memo)) return { ok: false, reason: 'bad-memo' };
  return { ok: true };
}

module.exports = { UNLOCK_V, unlockMemo, isUnlockMemo, verifyPayment };

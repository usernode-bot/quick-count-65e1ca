// Quick Count — on-chain memo envelopes (v1).
//
// Every state-changing event is a Usernode transaction whose memo string
// carries one of these JSON envelopes. Keys are deliberately short to stay
// within chain memo length limits. The submitter pubkey and timestamp are
// taken from the transaction itself, never from the memo.

const V = 1;
const TYPES = ['el', 'cand', 'stn', 'res'];

function electionMemo(name) {
  return { v: V, t: 'el', name: String(name || '').slice(0, 120) };
}

function candidateMemo(eid, cid, name) {
  return { v: V, t: 'cand', eid: String(eid), cid: Number(cid), name: String(name || '').slice(0, 80) };
}

function stationMemo(eid, sid, name) {
  return { v: V, t: 'stn', eid: String(eid), sid: Number(sid), name: String(name || '').slice(0, 80) };
}

function resultMemo(eid, sid, votes, tot, inv) {
  const m = { v: V, t: 'res', eid: String(eid), sid: Number(sid), votes: {} };
  const src = votes && typeof votes === 'object' ? votes : {};
  for (const k of Object.keys(src)) {
    const n = Number(src[k]);
    if (Number.isFinite(n)) m.votes[String(Number(k))] = Math.max(0, Math.round(n));
  }
  if (tot != null && tot !== '' && Number.isFinite(Number(tot))) m.tot = Math.max(0, Math.round(Number(tot)));
  if (inv != null && inv !== '' && Number.isFinite(Number(inv))) m.inv = Math.max(0, Math.round(Number(inv)));
  return m;
}

function encode(env) {
  return JSON.stringify(env);
}

// Parse + validate a memo string. Returns the envelope or null when the
// string is not a well-formed v1 Quick Count memo.
function decode(str) {
  if (typeof str !== 'string' || !str) return null;
  let o;
  try { o = JSON.parse(str); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.v !== V) return null;
  if (!TYPES.includes(o.t)) return null;
  return o;
}

module.exports = { V, TYPES, electionMemo, candidateMemo, stationMemo, resultMemo, encode, decode };

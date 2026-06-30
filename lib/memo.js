// Quick Count — on-chain memo envelopes (app:"quickcount", v1).
//
// Every state-changing event is a Usernode transaction whose memo string
// carries one of these JSON envelopes. Keys are deliberately short to stay
// within chain memo length limits. The submitter pubkey, recipient, amount
// and timestamp are taken from the transaction itself, never from the memo.
//
// The same builders are mirrored inline in public/index.html so the browser
// can sign transactions without a bundler. Keep the two in sync.

const APP = 'quickcount';
const V = 1;
const TYPES = ['org', 'el', 'cand', 'stn', 'obs', 'res', 'disp', 'dres', 'omem', 'orem', 'ovis', 'odel', 'oedit', 'ecl'];
const VERDICTS = ['uphold', 'reject'];
const ORG_ROLES = ['admin', 'mod', 'member']; // assignable member roles (Owner is implicit)
const VISIBILITIES = ['public', 'private'];

function clampStr(s, n) {
  return String(s == null ? '' : s).slice(0, n);
}
function posInt(n) {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.round(x)) : null;
}
function isHash64(s) {
  return typeof s === 'string' && /^[0-9a-f]{64}$/i.test(s);
}

// Normalize a free-form votes object into { "<cid>": <non-negative int> }.
function cleanVotes(votes) {
  const out = {};
  const src = votes && typeof votes === 'object' && !Array.isArray(votes) ? votes : {};
  const keys = Object.keys(src).slice(0, 64); // cap candidate count in a single memo
  for (const k of keys) {
    const cid = Number(k);
    const n = posInt(src[k]);
    if (Number.isInteger(cid) && cid >= 1 && n != null) out[String(cid)] = n;
  }
  return out;
}

// ── Builders ─────────────────────────────────────────────────────────────
function orgMemo(name, jur) {
  return { app: APP, v: V, t: 'org', name: clampStr(name, 120), jur: clampStr(jur, 80) };
}
function electionMemo(name) {
  return { app: APP, v: V, t: 'el', name: clampStr(name, 120) };
}
function candidateMemo(eid, cid, name) {
  return { app: APP, v: V, t: 'cand', eid: String(eid), cid: Number(cid), name: clampStr(name, 80) };
}
function stationMemo(eid, sid, name, label) {
  return { app: APP, v: V, t: 'stn', eid: String(eid), sid: Number(sid), name: clampStr(name, 80), label: clampStr(label, 80) };
}
function observerMemo(eid, addr, sid) {
  const m = { app: APP, v: V, t: 'obs', eid: String(eid), addr: String(addr) };
  if (sid != null && sid !== '') m.sid = Number(sid);
  return m;
}
function resultMemo(eid, sid, votes, tot, inv, ev) {
  const m = { app: APP, v: V, t: 'res', eid: String(eid), sid: Number(sid), votes: cleanVotes(votes) };
  const t = posInt(tot);
  const i = posInt(inv);
  if (t != null) m.tot = t;
  if (i != null) m.inv = i;
  if (isHash64(ev)) m.ev = String(ev).toLowerCase();
  return m;
}
function disputeMemo(eid, target, reason, ev) {
  const m = { app: APP, v: V, t: 'disp', eid: String(eid), target: String(target), reason: clampStr(reason, 200) };
  if (isHash64(ev)) m.ev = String(ev).toLowerCase();
  return m;
}
function resolveMemo(eid, disp, verdict) {
  return { app: APP, v: V, t: 'dres', eid: String(eid), disp: String(disp), verdict: VERDICTS.includes(verdict) ? verdict : 'reject' };
}
// ── Organization management builders ───────────────────────────────────────
// Add or update a member (latest-wins per (org, addr) — doubles as promote/demote).
function memberMemo(org, addr, role) {
  return { app: APP, v: V, t: 'omem', org: String(org || ''), addr: String(addr || ''), role: ORG_ROLES.includes(role) ? role : 'member' };
}
// Remove a member from an org.
function removeMemberMemo(org, addr) {
  return { app: APP, v: V, t: 'orem', org: String(org || ''), addr: String(addr || '') };
}
// Set org visibility (public | private). Latest-wins.
function visibilityMemo(org, vis) {
  return { app: APP, v: V, t: 'ovis', org: String(org || ''), vis: VISIBILITIES.includes(vis) ? vis : 'public' };
}
// Delete (tombstone) an org.
function deleteOrgMemo(org) {
  return { app: APP, v: V, t: 'odel', org: String(org || '') };
}
// Edit org name/jurisdiction. Owner only.
function editOrgMemo(org, name, jur) {
  return { app: APP, v: V, t: 'oedit', org: clampStr(org, 100), name: clampStr(name, 120), jur: clampStr(jur, 80) };
}
// Close an election (structural lock). Owner only.
function electionCloseMemo(eid) {
  return { app: APP, v: V, t: 'ecl', eid: String(eid) };
}

function encode(env) {
  return JSON.stringify(env);
}

// Parse + validate a memo string. Returns a normalized envelope, or null when
// the string is not a well-formed v1 Quick Count memo of a known type.
function decode(str) {
  if (typeof str !== 'string' || !str) return null;
  let o;
  try { o = JSON.parse(str); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if (o.app !== APP || o.v !== V || !TYPES.includes(o.t)) return null;

  switch (o.t) {
    case 'org':
      return { app: APP, v: V, t: 'org', name: clampStr(o.name, 120) || 'Untitled organization', jur: clampStr(o.jur, 80) };
    case 'el':
      return { app: APP, v: V, t: 'el', name: clampStr(o.name, 120) || 'Untitled election' };
    case 'cand': {
      if (!o.eid || !Number.isInteger(o.cid) || o.cid < 1) return null;
      return { app: APP, v: V, t: 'cand', eid: String(o.eid), cid: o.cid, name: clampStr(o.name, 80) || ('Candidate ' + o.cid) };
    }
    case 'stn': {
      if (!o.eid || !Number.isInteger(o.sid) || o.sid < 1) return null;
      return { app: APP, v: V, t: 'stn', eid: String(o.eid), sid: o.sid, name: clampStr(o.name, 80) || ('Station ' + o.sid), label: clampStr(o.label, 80) };
    }
    case 'obs': {
      if (!o.eid || !o.addr) return null;
      const m = { app: APP, v: V, t: 'obs', eid: String(o.eid), addr: String(o.addr) };
      if (o.sid != null && Number.isInteger(o.sid)) m.sid = o.sid;
      return m;
    }
    case 'res': {
      if (!o.eid || !Number.isInteger(o.sid) || o.sid < 1) return null;
      const m = { app: APP, v: V, t: 'res', eid: String(o.eid), sid: o.sid, votes: cleanVotes(o.votes) };
      const t = posInt(o.tot); const i = posInt(o.inv);
      if (t != null) m.tot = t;
      if (i != null) m.inv = i;
      if (isHash64(o.ev)) m.ev = String(o.ev).toLowerCase();
      return m;
    }
    case 'disp': {
      if (!o.eid || !o.target) return null;
      const m = { app: APP, v: V, t: 'disp', eid: String(o.eid), target: String(o.target), reason: clampStr(o.reason, 200) };
      if (isHash64(o.ev)) m.ev = String(o.ev).toLowerCase();
      return m;
    }
    case 'dres': {
      if (!o.eid || !o.disp || !VERDICTS.includes(o.verdict)) return null;
      return { app: APP, v: V, t: 'dres', eid: String(o.eid), disp: String(o.disp), verdict: o.verdict };
    }
    case 'oedit': {
      if (!o.org) return null;
      return { app: APP, v: V, t: 'oedit', org: clampStr(o.org, 100), name: clampStr(o.name, 120), jur: clampStr(o.jur, 80) };
    }
    case 'ecl': {
      if (!o.eid) return null;
      return { app: APP, v: V, t: 'ecl', eid: String(o.eid) };
    }
    case 'omem': {
      if (!o.org || !o.addr || !ORG_ROLES.includes(o.role)) return null;
      return { app: APP, v: V, t: 'omem', org: String(o.org), addr: String(o.addr), role: o.role };
    }
    case 'orem': {
      if (!o.org || !o.addr) return null;
      return { app: APP, v: V, t: 'orem', org: String(o.org), addr: String(o.addr) };
    }
    case 'ovis': {
      if (!o.org || !VISIBILITIES.includes(o.vis)) return null;
      return { app: APP, v: V, t: 'ovis', org: String(o.org), vis: o.vis };
    }
    case 'odel': {
      if (!o.org) return null;
      return { app: APP, v: V, t: 'odel', org: String(o.org) };
    }
    default:
      return null;
  }
}

module.exports = {
  APP, V, TYPES, VERDICTS, ORG_ROLES, VISIBILITIES,
  orgMemo, electionMemo, candidateMemo, stationMemo, observerMemo,
  resultMemo, disputeMemo, resolveMemo,
  memberMemo, removeMemberMemo, visibilityMemo, deleteOrgMemo,
  editOrgMemo, electionCloseMemo,
  encode, decode, isHash64, cleanVotes,
};

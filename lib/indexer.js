// Quick Count — deterministic transaction indexer (state machine).
//
// QuickCountIndexer reconstructs all read state by replaying the on-chain
// transaction log in (createdAt, txId) order. Replaying the same log always
// yields identical state (deterministic + idempotent), so the read model is
// disposable: drop it and re-index to recover. The log is the source of truth.
//
// Identity is the wallet address — there is no server-side login. Authorization
// is enforced here, deterministically, from each transaction's `from` field.

const { decode } = require('./memo');
const agg = require('./aggregate');

function pickFirst(o, keys) {
  for (const k of keys) if (o[k] != null) return o[k];
  return null;
}

// Map the many transaction field-name variants the bridge/explorer may use
// into a single shape: { txId, from, to, memo, amount, createdAt(ISO) }.
function normalizeTx(raw) {
  if (!raw || typeof raw !== 'object') return {};
  let txId = null;
  for (const v of [raw.id, raw.txid, raw.txId, raw.tx_id, raw.hash, raw.tx_hash, raw.txHash]) {
    if (typeof v === 'string' && v.trim()) { txId = v.trim(); break; }
  }
  const from = pickFirst(raw, ['from_pubkey', 'sender', 'account', 'from']);
  const to = pickFirst(raw, ['destination_pubkey', 'destination', 'to', 'recipient']);
  const memo = raw.memo == null ? null : String(raw.memo);
  const amountRaw = pickFirst(raw, ['amount', 'value', 'amt']);
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
    amount: amountRaw == null ? 0 : Number(amountRaw) || 0,
    createdAt,
  };
}

function sortTxs(txs) {
  return txs.slice().sort((a, b) => {
    const ka = `${a.createdAt || ''}|${a.txId || ''}`;
    const kb = `${b.createdAt || ''}|${b.txId || ''}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

class QuickCountIndexer {
  constructor(config = {}) {
    this.treasury = config.treasury || '';
    this.orgFee = Number(config.orgFee) || 0;
    this.reset();
  }

  reset() {
    this.orgs = new Map();        // addr -> { addr, name, jur, feeAmount, active, visibility, deleted, members:Map<addr,role>, txId, createdAt }
    this.elections = new Map();   // eid -> { eid, name, orgAddr, txId, createdAt }
    this.candidates = new Map();  // eid -> Map cid -> { cid, name, txId }
    this.stations = new Map();    // eid -> Map sid -> { sid, name, label, txId }
    this.observers = new Map();   // eid -> Map addr -> { addr, sid|null, txId }
    this.results = new Map();     // eid -> [ result ]
    this.resultByTx = new Map();  // txId -> result
    this.disputes = new Map();    // eid -> [ dispute ]
    this.disputeByTx = new Map(); // txId -> dispute
    this.processed = new Set();   // txId set — inclusion / idempotency cache
  }

  // Resolve a wallet's role within an org. The founding wallet (org.addr) is the
  // implicit Owner — the creator IS the owner, with full authority over the
  // org's data — and is never stored in `members`. Returns one of
  // 'owner' | 'admin' | 'mod' | 'member' | null. A deleted org has no roles.
  orgRole(orgAddr, wallet) {
    if (!orgAddr || !wallet) return null;
    const org = this.orgs.get(orgAddr);
    if (!org || org.deleted) return null;
    if (wallet === org.addr) return 'owner';
    return org.members.get(wallet) || null;
  }

  // Whether a wallet may perform election operations (create/structural/resolve)
  // for an org: Owner, Administrator, or Moderator. Members and outsiders cannot.
  // Management/operation powers unlock only once the org has PAID its fee
  // (org.active) — a pending org's owner can pay or abandon it, but not operate
  // on its data. A deleted or unknown org grants no operation rights.
  canOperate(orgAddr, wallet) {
    const org = this.orgs.get(orgAddr);
    if (!org || org.deleted || !org.active) return false;
    const r = this.orgRole(orgAddr, wallet);
    return r === 'owner' || r === 'admin' || r === 'mod';
  }

  // Platform-level administrator check (break-glass override). Reserved for
  // future use — currently no on-chain `adm` transaction populates this set,
  // so this always returns false and every org gate falls through to canOperate.
  isAdmin(_wallet) {
    return false;
  }

  // Replay the full transaction log from scratch.
  rebuild(txs) {
    this.reset();
    for (const t of sortTxs(txs || [])) this.apply(t);
    return this;
  }

  // Apply a single normalized transaction. Returns { applied, reason?, kind? }.
  apply(tx) {
    if (!tx || !tx.txId) return { applied: false, reason: 'no-txid' };
    if (this.processed.has(tx.txId)) return { applied: false, reason: 'dup' };
    this.processed.add(tx.txId);

    const env = decode(tx.memo);
    if (!env) return { applied: false, reason: 'bad-memo' };
    const at = tx.createdAt || null;

    switch (env.t) {
      case 'org': return this._org(tx, env, at);
      case 'el': return this._election(tx, env, at);
      case 'cand': return this._structural(tx, env, 'cand', at);
      case 'stn': return this._structural(tx, env, 'stn', at);
      case 'obs': return this._structural(tx, env, 'obs', at);
      case 'res': return this._result(tx, env, at);
      case 'disp': return this._dispute(tx, env, at);
      case 'dres': return this._resolve(tx, env);
      case 'omem': return this._member(tx, env);
      case 'orem': return this._removeMember(tx, env);
      case 'ovis': return this._visibility(tx, env);
      case 'odel': return this._deleteOrg(tx, env);
      case 'ecl': return this._closeElection(tx, env);
      case 'oedit': return this._editOrg(tx, env);
      default: return { applied: false, reason: 'unknown-type' };
    }
  }

  _org(tx, env, at) {
    const addr = tx.from;
    if (!addr) return { applied: false, reason: 'no-sender' };
    const paid = tx.to === this.treasury && Number(tx.amount) >= this.orgFee;
    const existing = this.orgs.get(addr);
    if (!existing) {
      this.orgs.set(addr, {
        addr, name: env.name, jur: env.jur || '', feeAmount: Number(tx.amount) || 0,
        active: paid, visibility: 'public', deleted: false, members: new Map(),
        txId: tx.txId, createdAt: at,
      });
    } else if (existing.deleted) {
      return { applied: false, reason: 'org-deleted' };
    } else if (!existing.active && paid) {
      // A later top-up transaction can settle the fee.
      existing.active = true;
      existing.feeAmount = Number(tx.amount) || existing.feeAmount;
    }
    return { applied: true, kind: 'org', active: this.orgs.get(addr).active };
  }

  _election(tx, env, at) {
    // The election is owned by the operator's org. Founder (Owner) creates it
    // under their own org; Admins/Moderators create it under the org they serve.
    let org = this.orgs.get(tx.from);
    if (!org) {
      // Resolve via membership: the first org where tx.from can operate.
      for (const o of this.orgs.values()) {
        if (!o.deleted && this.canOperate(o.addr, tx.from)) { org = o; break; }
      }
    }
    if (!org) return { applied: false, reason: 'unknown-org' };
    if (org.deleted) return { applied: false, reason: 'org-deleted' };
    if (!this.canOperate(org.addr, tx.from)) return { applied: false, reason: 'unauthorized' };
    const eid = tx.txId;
    if (!this.elections.has(eid)) {
      this.elections.set(eid, { eid, name: env.name, orgAddr: org.addr, txId: eid, createdAt: at, closed: false });
      this.candidates.set(eid, new Map());
      this.stations.set(eid, new Map());
      this.observers.set(eid, new Map());
      this.results.set(eid, []);
      this.disputes.set(eid, []);
    }
    return { applied: true, kind: 'el', eid };
  }

  _structural(tx, env, kind, at) {
    const el = this.elections.get(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    const org = this.orgs.get(el.orgAddr);
    if (org && org.deleted) return { applied: false, reason: 'org-deleted' };
    // Structural changes come from the election's org: Owner, Administrator, or
    // Moderator. A platform operator may also act here as a BREAK-GLASS override
    // (support / abandoned-org recovery), not as part of normal governance.
    if (!this.canOperate(el.orgAddr, tx.from) && !this.isAdmin(tx.from)) return { applied: false, reason: 'unauthorized' };
    if (el.closed) return { applied: false, reason: 'election-closed' };

    if (kind === 'cand') {
      const m = this.candidates.get(env.eid);
      if (!m.has(env.cid)) m.set(env.cid, { cid: env.cid, name: env.name, txId: tx.txId });
      return { applied: true, kind };
    }
    if (kind === 'stn') {
      const m = this.stations.get(env.eid);
      if (!m.has(env.sid)) m.set(env.sid, { sid: env.sid, name: env.name, label: env.label || '', txId: tx.txId });
      return { applied: true, kind };
    }
    // obs
    const m = this.observers.get(env.eid);
    if (!m.has(env.addr)) m.set(env.addr, { addr: env.addr, sid: env.sid == null ? null : env.sid, txId: tx.txId });
    return { applied: true, kind };
  }

  _closeElection(tx, env) {
    const el = this.elections.get(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    const org = this.orgs.get(el.orgAddr);
    if (org && org.deleted) return { applied: false, reason: 'org-deleted' };
    if (org && !org.active) return { applied: false, reason: 'org-inactive' };
    if (this.orgRole(el.orgAddr, tx.from) !== 'owner') return { applied: false, reason: 'unauthorized' };
    el.closed = true;
    return { applied: true, kind: 'ecl' };
  }

  _result(tx, env, at) {
    const el = this.elections.get(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    const obs = this.observers.get(env.eid).get(tx.from);
    if (!obs) return { applied: false, reason: 'not-observer' };
    if (obs.sid != null && obs.sid !== env.sid) return { applied: false, reason: 'wrong-station' };
    if (!this.stations.get(env.eid).has(env.sid)) return { applied: false, reason: 'unknown-station' };

    const row = {
      txId: tx.txId, eid: env.eid, sid: env.sid, observer: tx.from,
      votes: env.votes || {}, tot: env.tot == null ? null : env.tot,
      inv: env.inv == null ? null : env.inv, ev: env.ev || null,
      createdAt: at, invalid: false, disputed: false,
    };
    this.results.get(env.eid).push(row);
    this.resultByTx.set(tx.txId, row);
    return { applied: true, kind: 'res' };
  }

  _dispute(tx, env, at) {
    const el = this.elections.get(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    const org = this.orgs.get(el.orgAddr);
    if (org && org.deleted) return { applied: false, reason: 'org-deleted' };
    const isObserver = this.observers.get(env.eid).has(tx.from);
    const isOrg = this.canOperate(el.orgAddr, tx.from);
    if (!isObserver && !isOrg) return { applied: false, reason: 'unauthorized' };
    const target = this.resultByTx.get(env.target);
    if (!target || target.eid !== env.eid) return { applied: false, reason: 'unknown-target' };

    const d = {
      txId: tx.txId, eid: env.eid, target: env.target, filer: tx.from,
      reason: env.reason || '', ev: env.ev || null, status: 'open',
      resolutionTx: null, createdAt: at,
    };
    this.disputes.get(env.eid).push(d);
    this.disputeByTx.set(tx.txId, d);
    target.disputed = true; // flagged until resolved
    return { applied: true, kind: 'disp' };
  }

  _resolve(tx, env) {
    const el = this.elections.get(env.eid);
    if (!el) return { applied: false, reason: 'unknown-election' };
    const org = this.orgs.get(el.orgAddr);
    if (org && org.deleted) return { applied: false, reason: 'org-deleted' };
    if (!this.canOperate(el.orgAddr, tx.from)) return { applied: false, reason: 'unauthorized' };
    const d = this.disputeByTx.get(env.disp);
    if (!d || d.eid !== env.eid) return { applied: false, reason: 'unknown-dispute' };

    d.resolutionTx = tx.txId;
    const target = this.resultByTx.get(d.target);
    if (env.verdict === 'uphold') {
      d.status = 'upheld';
      if (target) { target.invalid = true; target.disputed = false; }
    } else {
      d.status = 'rejected';
      // Clear the disputed flag only if no other open dispute targets this result.
      if (target) {
        const stillOpen = (this.disputes.get(env.eid) || []).some((x) => x.target === d.target && x.status === 'open');
        target.disputed = stillOpen;
      }
    }
    return { applied: true, kind: 'dres', verdict: env.verdict };
  }

  // ── Organization management ──────────────────────────────────────────────

  // Add or update a member. Owner may set any role; Administrator may set only
  // member/mod and may not touch the Owner or another Administrator.
  _member(tx, env) {
    const org = this.orgs.get(env.org);
    if (!org) return { applied: false, reason: 'unknown-org' };
    if (org.deleted) return { applied: false, reason: 'org-deleted' };
    if (!org.active) return { applied: false, reason: 'org-inactive' };
    if (env.addr === org.addr) return { applied: false, reason: 'owner-immutable' };
    const actor = this.orgRole(org.addr, tx.from);
    if (actor === 'owner') {
      org.members.set(env.addr, env.role);
      return { applied: true, kind: 'omem', role: env.role };
    }
    if (actor === 'admin') {
      // Admins manage Members/Moderators only, and never another Admin.
      if (env.role === 'admin') return { applied: false, reason: 'unauthorized' };
      if (org.members.get(env.addr) === 'admin') return { applied: false, reason: 'unauthorized' };
      org.members.set(env.addr, env.role);
      return { applied: true, kind: 'omem', role: env.role };
    }
    return { applied: false, reason: 'unauthorized' };
  }

  // Remove a member. Owner may remove any member; Administrator may remove only
  // Members/Moderators (never the Owner or another Administrator).
  _removeMember(tx, env) {
    const org = this.orgs.get(env.org);
    if (!org) return { applied: false, reason: 'unknown-org' };
    if (org.deleted) return { applied: false, reason: 'org-deleted' };
    if (!org.active) return { applied: false, reason: 'org-inactive' };
    if (env.addr === org.addr) return { applied: false, reason: 'owner-immutable' };
    const actor = this.orgRole(org.addr, tx.from);
    if (actor === 'owner') {
      org.members.delete(env.addr);
      return { applied: true, kind: 'orem' };
    }
    if (actor === 'admin') {
      if (org.members.get(env.addr) === 'admin') return { applied: false, reason: 'unauthorized' };
      org.members.delete(env.addr);
      return { applied: true, kind: 'orem' };
    }
    return { applied: false, reason: 'unauthorized' };
  }

  // Set org visibility. Owner or Administrator.
  _visibility(tx, env) {
    const org = this.orgs.get(env.org);
    if (!org) return { applied: false, reason: 'unknown-org' };
    if (org.deleted) return { applied: false, reason: 'org-deleted' };
    if (!org.active) return { applied: false, reason: 'org-inactive' };
    const actor = this.orgRole(org.addr, tx.from);
    if (actor !== 'owner' && actor !== 'admin') return { applied: false, reason: 'unauthorized' };
    org.visibility = env.vis;
    return { applied: true, kind: 'ovis', vis: env.vis };
  }

  // Delete (tombstone) the org. Owner only.
  _deleteOrg(tx, env) {
    const org = this.orgs.get(env.org);
    if (!org) return { applied: false, reason: 'unknown-org' };
    if (this.orgRole(org.addr, tx.from) !== 'owner') return { applied: false, reason: 'unauthorized' };
    org.deleted = true;
    return { applied: true, kind: 'odel' };
  }

  // Edit org display name and jurisdiction. Owner only. Latest-wins.
  _editOrg(tx, env) {
    const org = this.orgs.get(env.org);
    if (!org) return { applied: false, reason: 'unknown-org' };
    if (org.deleted) return { applied: false, reason: 'org-deleted' };
    if (!org.active) return { applied: false, reason: 'org-inactive' };
    if (this.orgRole(org.addr, tx.from) !== 'owner') return { applied: false, reason: 'unauthorized' };
    const name = (env.name || '').trim();
    if (!name) return { applied: false, reason: 'empty-name' };
    org.name = name;
    org.jur = env.jur || '';
    return { applied: true, kind: 'oedit' };
  }

  // ── Snapshots (visibility-aware) ─────────────────────────────────────────

  // Which elections are visible to a viewer: any active org's elections are
  // public; an org owner additionally sees its own (pending) elections.
  visibleElections({ viewer } = {}) {
    const out = [];
    for (const el of this.elections.values()) {
      const org = this.orgs.get(el.orgAddr);
      if (!org) continue;
      if (org.deleted) continue;
      const isOwner = viewer && el.orgAddr === viewer;
      if (!(org.active || isOwner)) continue;
      // Private orgs are visible only to members (any role) or the org wallet.
      if (org.visibility === 'private' && !this.orgRole(org.addr, viewer)) continue;
      out.push(el);
    }
    return out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  electionSummary(el) {
    const org = this.orgs.get(el.orgAddr);
    const results = this.results.get(el.eid) || [];
    const reported = new Set(results.filter((r) => !r.invalid).map((r) => r.sid));
    return {
      eid: el.eid, name: el.name, orgAddr: el.orgAddr,
      orgName: org ? org.name : null, orgActive: org ? org.active : false,
      createdAt: el.createdAt, closed: el.closed || false,
      candidateCount: (this.candidates.get(el.eid) || new Map()).size,
      stationCount: (this.stations.get(el.eid) || new Map()).size,
      reportedCount: reported.size,
      disputeCount: (this.disputes.get(el.eid) || []).length,
    };
  }

  // Full detail for one election under a chosen aggregation method.
  electionDetail(eid, method = 'latest') {
    const el = this.elections.get(eid);
    if (!el) return null;
    const org = this.orgs.get(el.orgAddr);
    const candidates = Array.from((this.candidates.get(eid) || new Map()).values()).sort((a, b) => a.cid - b.cid);
    const stationList = Array.from((this.stations.get(eid) || new Map()).values()).sort((a, b) => a.sid - b.sid);
    const results = this.results.get(eid) || [];

    const stationMap = agg.perStation(method, results);
    const tally = agg.computeTally(candidates, stationMap);
    const prog = agg.reporting(stationList, stationMap);
    const mr = agg.marginAndReview(candidates, results, stationMap, tally);

    const stations = stationList.map((s) => {
      const row = stationMap.get(s.sid);
      const flag = mr.stationFlags[s.sid] || { needsReview: false, sources: 0 };
      return {
        sid: s.sid, name: s.name, label: s.label || '',
        reported: !!row,
        votes: row ? row.votes : null,
        tot: row ? row.tot : null,
        inv: row ? row.inv : null,
        at: row ? row.at : null,
        observer: row ? row.observer : null,
        ev: row ? row.ev : null,
        resultTx: row ? row.txId : null,
        sources: flag.sources,
        invalid: row ? !!row.invalid : false,
        disputed: row ? !!row.disputed : false,
        needsReview: !!flag.needsReview,
      };
    });

    let lastUpdated = null;
    for (const r of results) if (r.createdAt && (!lastUpdated || r.createdAt > lastUpdated)) lastUpdated = r.createdAt;

    return {
      election: { eid: el.eid, name: el.name, orgAddr: el.orgAddr, orgName: org ? org.name : null, orgActive: org ? org.active : false, orgJur: org ? (org.jur || '') : '', createdAt: el.createdAt, closed: el.closed || false },
      method,
      candidates: candidates.map((c) => ({ cid: c.cid, name: c.name })),
      stations,
      tally,
      reporting: prog,
      margin: { leadMarginPct: mr.leadMarginPct, uncertaintyPct: mr.uncertaintyPct, needsReview: mr.needsReview },
      observers: Array.from((this.observers.get(eid) || new Map()).values()),
      disputes: (this.disputes.get(eid) || []).map((d) => ({ ...d })),
      evidence: results.filter((r) => r.ev).map((r) => ({
        sid: r.sid, observer: r.observer, ev: r.ev, txId: r.txId, at: r.createdAt, invalid: r.invalid,
      })),
      lastUpdated,
    };
  }

  // Role of a viewer wallet across the whole app (drives the UI tabs).
  viewerRole(viewer) {
    const org = viewer ? this.orgs.get(viewer) : null;
    const observerOf = [];
    if (viewer) {
      for (const [eid, m] of this.observers) if (m.has(viewer)) observerOf.push({ eid, sid: m.get(viewer).sid });
    }
    const ownOrg = org && !org.deleted ? org : null;
    return {
      addr: viewer || null,
      org: ownOrg ? { addr: ownOrg.addr, name: ownOrg.name, jur: ownOrg.jur, active: ownOrg.active, visibility: ownOrg.visibility } : null,
      observerOf,
      orgsOwned: ownOrg ? [this._orgCard(ownOrg, 'owner')] : [],
      orgsMember: this._memberOrgs(viewer),
    };
  }

  // A compact card for an org as seen by a viewer with the given role.
  _orgCard(org, role) {
    return { addr: org.addr, name: org.name, jur: org.jur || '', active: org.active, visibility: org.visibility, role };
  }

  // Orgs (excluding the one this wallet owns) where the wallet holds a role.
  _memberOrgs(viewer) {
    const out = [];
    if (!viewer) return out;
    for (const org of this.orgs.values()) {
      if (org.deleted) continue;
      if (org.addr === viewer) continue; // owned org lives in orgsOwned
      const role = org.members.get(viewer);
      if (role) out.push(this._orgCard(org, role));
    }
    return out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  // Full org detail for one org as seen by `viewer` — card + roster. Returns null
  // when the org is unknown/deleted or the viewer has no role in it.
  orgDetail(orgAddr, viewer) {
    const org = this.orgs.get(orgAddr);
    if (!org || org.deleted) return null;
    const viewerRole = this.orgRole(org.addr, viewer);
    if (!viewerRole) return null;
    const members = [{ addr: org.addr, role: 'owner' }];
    for (const [addr, role] of org.members) members.push({ addr, role });
    return {
      addr: org.addr, name: org.name, jur: org.jur || '',
      active: org.active, visibility: org.visibility,
      viewerRole, members,
    };
  }

  // Owned + member-of orgs for a viewer, each with its roster (for the Orgs tab).
  orgsForViewer(viewer) {
    const role = this.viewerRole(viewer);
    const cards = [...role.orgsOwned, ...role.orgsMember];
    const detail = cards.map((c) => this.orgDetail(c.addr, viewer)).filter(Boolean);
    return { viewer: viewer || null, orgs: detail };
  }

  allOrgs() {
    return Array.from(this.orgs.values())
      .map((o) => ({
        addr: o.addr, name: o.name, jur: o.jur || '', feeAmount: o.feeAmount,
        active: o.active, visibility: o.visibility,
        deleted: !!o.deleted, memberCount: o.members.size,
        txId: o.txId, createdAt: o.createdAt,
      }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  // Public projection of active organizations (fee paid), newest-first.
  // Independent of whether the org has published any elections, so a freshly
  // registered org surfaces immediately. Minimal shape — never leaks feeAmount/txId.
  activeOrgs() {
    return this.allOrgs()
      .filter((o) => o.active)
      .map((o) => ({ addr: o.addr, name: o.name, jur: o.jur || '' }));
  }

  // Organizations the subject `addr` owns or belongs to, projected for a
  // requesting `viewer`. Reuses the same visibility rules as visibleElections /
  // orgDetail so a public profile never leaks a private org's name:
  //   • deleted orgs are excluded for everyone;
  //   • an active + public org is visible to anyone;
  //   • otherwise (pending and/or private) it is shown only to a viewer who
  //     holds a role in it — which is how the subject always sees their own
  //     pending org and how a private org stays visible to its members.
  // Each entry: { addr, name, jur, role, active, visibility } where `role` is
  // the SUBJECT's role (founding wallet → 'owner').
  orgsForAddr(addr, viewer) {
    if (!addr) return [];
    const out = [];
    for (const org of this.orgs.values()) {
      if (org.deleted) continue;
      const role = this.orgRole(org.addr, addr); // subject's role in this org
      if (!role) continue;
      const visible = (org.active && org.visibility !== 'private')
        || !!this.orgRole(org.addr, viewer);
      if (!visible) continue;
      out.push({
        addr: org.addr, name: org.name, jur: org.jur || '',
        role, active: org.active, visibility: org.visibility,
      });
    }
    return out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  // Activity for one wallet address, filtered to a set of visible election ids.
  // Returns { resultCount, disputeCount, electionCount, organizations, history }
  // where history is the newest-first list of results the address submitted
  // (max 20 items) and organizations is the visibility-filtered list of orgs the
  // address owns/belongs to (see orgsForAddr). `opts` carries the requesting viewer.
  activityByAddr(addr, visibleEids, opts = {}) {
    if (!addr) return { resultCount: 0, disputeCount: 0, electionCount: 0, organizations: [], history: [] };
    const visibleSet = new Set(visibleEids || []);

    let resultCount = 0;
    const historyItems = [];

    for (const [eid, results] of this.results) {
      if (!visibleSet.has(eid)) continue;
      const el = this.elections.get(eid);
      const stMap = this.stations.get(eid) || new Map();
      for (const r of results) {
        if (r.observer !== addr) continue;
        if (!r.invalid) resultCount++;
        const st = stMap.get(r.sid);
        historyItems.push({
          eid,
          election_name: el ? el.name : eid,
          sid: r.sid,
          station_name: st ? st.name : ('Station ' + r.sid),
          submitted_at: r.createdAt,
        });
      }
    }

    let disputeCount = 0;
    for (const [eid, disputes] of this.disputes) {
      if (!visibleSet.has(eid)) continue;
      for (const d of disputes) {
        if (d.filer === addr) disputeCount++;
      }
    }

    let electionCount = 0;
    for (const eid of visibleSet) {
      const obsMap = this.observers.get(eid);
      const el = this.elections.get(eid);
      if ((obsMap && obsMap.has(addr)) || (el && el.orgAddr === addr)) {
        electionCount++;
      }
    }

    historyItems.sort((a, b) => String(b.submitted_at || '').localeCompare(String(a.submitted_at || '')));

    const organizations = this.orgsForAddr(addr, opts.viewer || null);

    return {
      resultCount,
      disputeCount,
      electionCount,
      organizations,
      history: historyItems.slice(0, 20),
    };
  }
}

module.exports = { normalizeTx, sortTxs, QuickCountIndexer };

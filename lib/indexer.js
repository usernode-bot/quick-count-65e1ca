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
    this.adminAddrs = new Set((config.adminAddrs || []).filter(Boolean));
    this.reset();
  }

  reset() {
    this.orgs = new Map();        // addr -> { addr, name, jur, feeAmount, active, txId, createdAt }
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

  isAdmin(addr) {
    return !!addr && this.adminAddrs.has(addr);
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
      case 'adm': return this._adm(tx, env);
      case 'el': return this._election(tx, env, at);
      case 'cand': return this._structural(tx, env, 'cand', at);
      case 'stn': return this._structural(tx, env, 'stn', at);
      case 'obs': return this._structural(tx, env, 'obs', at);
      case 'res': return this._result(tx, env, at);
      case 'disp': return this._dispute(tx, env, at);
      case 'dres': return this._resolve(tx, env);
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
        active: paid, txId: tx.txId, createdAt: at,
      });
    } else if (!existing.active && paid) {
      // A later top-up transaction can settle the fee.
      existing.active = true;
      existing.feeAmount = Number(tx.amount) || existing.feeAmount;
    }
    return { applied: true, kind: 'org', active: this.orgs.get(addr).active };
  }

  _adm(tx, env) {
    if (!this.isAdmin(tx.from)) return { applied: false, reason: 'unauthorized' };
    if (env.act === 'waive') {
      const org = this.orgs.get(env.org);
      if (!org) return { applied: false, reason: 'unknown-org' };
      org.active = true;
      org.waived = true;
      return { applied: true, kind: 'adm', act: 'waive' };
    }
    return { applied: false, reason: 'unknown-admin-act' };
  }

  _election(tx, env, at) {
    const org = this.orgs.get(tx.from);
    if (!org) return { applied: false, reason: 'unknown-org' };
    const eid = tx.txId;
    if (!this.elections.has(eid)) {
      this.elections.set(eid, { eid, name: env.name, orgAddr: org.addr, txId: eid, createdAt: at });
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
    // Structural changes must come from the election's organization.
    if (tx.from !== el.orgAddr && !this.isAdmin(tx.from)) return { applied: false, reason: 'unauthorized' };

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
    const isObserver = this.observers.get(env.eid).has(tx.from);
    const isOrg = tx.from === el.orgAddr;
    if (!isObserver && !isOrg && !this.isAdmin(tx.from)) return { applied: false, reason: 'unauthorized' };
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
    if (tx.from !== el.orgAddr && !this.isAdmin(tx.from)) return { applied: false, reason: 'unauthorized' };
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

  // ── Snapshots (visibility-aware) ─────────────────────────────────────────

  // Which elections are visible to a viewer: any active org's elections are
  // public; an org owner additionally sees its own (pending) elections; an
  // admin sees everything.
  visibleElections({ viewer, admin } = {}) {
    const out = [];
    for (const el of this.elections.values()) {
      const org = this.orgs.get(el.orgAddr);
      const isOwner = viewer && el.orgAddr === viewer;
      if (org && (org.active || isOwner || admin)) out.push(el);
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
      createdAt: el.createdAt,
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
      election: { eid: el.eid, name: el.name, orgAddr: el.orgAddr, orgName: org ? org.name : null, orgActive: org ? org.active : false, createdAt: el.createdAt },
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
    return {
      addr: viewer || null,
      isAdmin: this.isAdmin(viewer),
      org: org ? { addr: org.addr, name: org.name, jur: org.jur, active: org.active } : null,
      observerOf,
    };
  }

  allOrgs() {
    return Array.from(this.orgs.values()).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  }

  // Public projection of active organizations (fee paid or admin-waived),
  // newest-first. Independent of whether the org has published any elections,
  // so a freshly registered org surfaces immediately. Minimal shape — never
  // leaks feeAmount/txId/waived.
  activeOrgs() {
    return this.allOrgs()
      .filter((o) => o.active)
      .map((o) => ({ addr: o.addr, name: o.name, jur: o.jur || '' }));
  }

  // Activity for one wallet address, filtered to a set of visible election ids.
  // Returns { resultCount, disputeCount, electionCount, history } where history
  // is the newest-first list of results the address submitted (max 20 items).
  activityByAddr(addr, visibleEids) {
    if (!addr) return { resultCount: 0, disputeCount: 0, electionCount: 0, history: [] };
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

    return {
      resultCount,
      disputeCount,
      electionCount,
      history: historyItems.slice(0, 20),
    };
  }
}

module.exports = { normalizeTx, sortTxs, QuickCountIndexer };

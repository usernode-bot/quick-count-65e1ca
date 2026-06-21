// Quick Count — aggregation methods.
//
// Pure functions over plain result rows so they can be unit-tested without a
// database or chain. A "result row" is:
//   { sid, txId, observer, votes:{cid:n}, tot, inv, createdAt(ISO), invalid, disputed }
//
// Every per-station selector returns a Map<sid, stationRow> where a stationRow
// is { votes:{cid:n}, tot, inv, observer, at, sources, invalid, disputed }.
// Because they all share that shape, the dashboard, exports and tally code are
// method-agnostic.

const METHODS = ['latest', 'first', 'consensus', 'median', 'verified'];

function groupBySid(results) {
  const byStation = new Map();
  for (const r of results || []) {
    if (!byStation.has(r.sid)) byStation.set(r.sid, []);
    byStation.get(r.sid).push(r);
  }
  return byStation;
}

function rowFrom(r, sources) {
  return {
    votes: r.votes || {},
    tot: r.tot == null ? null : r.tot,
    inv: r.inv == null ? null : r.inv,
    observer: r.observer || null,
    at: r.createdAt || null,
    ev: r.ev || null,
    txId: r.txId || null,
    sources: sources == null ? 1 : sources,
    invalid: !!r.invalid,
    disputed: !!r.disputed,
  };
}

function pickLatest(list) {
  let best = null;
  for (const r of list) if (!best || cmp(r, best) > 0) best = r;
  return best;
}
function pickFirst(list) {
  let best = null;
  for (const r of list) if (!best || cmp(r, best) < 0) best = r;
  return best;
}
function cmp(a, b) {
  const ka = `${a.createdAt || ''}|${a.txId || ''}`;
  const kb = `${b.createdAt || ''}|${b.txId || ''}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

// All candidate ids referenced across a station's submissions.
function cidUniverse(list) {
  const s = new Set();
  for (const r of list) for (const k of Object.keys(r.votes || {})) s.add(Number(k));
  return Array.from(s);
}

function mode(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = values[0], bestC = -1;
  for (const [v, c] of counts) if (c > bestC) { best = v; bestC = c; }
  return best;
}
function median(values) {
  const a = values.slice().sort((x, y) => x - y);
  if (!a.length) return 0;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2);
}

// ── Per-station selectors ─────────────────────────────────────────────────
function latestPerStation(results) {
  const out = new Map();
  for (const [sid, list] of groupBySid(results)) out.set(sid, rowFrom(pickLatest(list), list.length));
  return out;
}
function firstPerStation(results) {
  const out = new Map();
  for (const [sid, list] of groupBySid(results)) out.set(sid, rowFrom(pickFirst(list), list.length));
  return out;
}
// Latest non-invalid submission. Stations whose only submissions were
// invalidated by an upheld dispute drop out entirely.
function verifiedLatestPerStation(results) {
  const out = new Map();
  for (const [sid, list] of groupBySid(results)) {
    const valid = list.filter((r) => !r.invalid);
    if (!valid.length) continue;
    out.set(sid, rowFrom(pickLatest(valid), valid.length));
  }
  return out;
}
// Per-candidate modal value across a station's submissions (ties → latest).
function consensusPerStation(results) {
  const out = new Map();
  for (const [sid, list] of groupBySid(results)) {
    const latest = pickLatest(list);
    const votes = {};
    for (const cid of cidUniverse(list)) {
      votes[cid] = mode(list.map((r) => Number((r.votes || {})[cid] || 0)));
    }
    out.set(sid, {
      votes, tot: latest.tot ?? null, inv: latest.inv ?? null,
      observer: 'consensus', at: latest.createdAt || null, ev: null, txId: null,
      sources: list.length, invalid: false, disputed: list.some((r) => r.disputed),
    });
  }
  return out;
}
// Per-candidate median across a station's submissions.
function medianPerStation(results) {
  const out = new Map();
  for (const [sid, list] of groupBySid(results)) {
    const latest = pickLatest(list);
    const votes = {};
    for (const cid of cidUniverse(list)) {
      votes[cid] = median(list.map((r) => Number((r.votes || {})[cid] || 0)));
    }
    out.set(sid, {
      votes, tot: latest.tot ?? null, inv: latest.inv ?? null,
      observer: 'median', at: latest.createdAt || null, ev: null, txId: null,
      sources: list.length, invalid: false, disputed: list.some((r) => r.disputed),
    });
  }
  return out;
}

const SELECTORS = {
  latest: latestPerStation,
  first: firstPerStation,
  consensus: consensusPerStation,
  median: medianPerStation,
  verified: verifiedLatestPerStation,
};

function perStation(method, results) {
  const fn = SELECTORS[method] || latestPerStation;
  return fn(results);
}

// Sum votes per candidate across the chosen per-station rows.
function computeTally(candidates, stationMap) {
  const tally = {};
  for (const c of candidates || []) tally[c.cid] = 0;
  for (const row of stationMap.values()) {
    const votes = row.votes || {};
    for (const k of Object.keys(votes)) {
      const cid = Number(k);
      if (!(cid in tally)) tally[cid] = 0;
      tally[cid] += Number(votes[k]) || 0;
    }
  }
  return tally;
}

function reporting(stations, stationMap) {
  let reported = 0;
  for (const s of stations || []) if (stationMap.has(s.sid)) reported++;
  return { reported, total: (stations || []).length };
}

// Disagreement spread for a single station = max over candidates of
// (max - min) across that station's submissions.
function stationSpread(list) {
  let spread = 0;
  for (const cid of cidUniverse(list)) {
    const vals = list.map((r) => Number((r.votes || {})[cid] || 0));
    spread = Math.max(spread, Math.max(...vals) - Math.min(...vals));
  }
  return spread;
}

// Per-station and election-level confidence signals.
//   station.needsReview — submissions disagree beyond tolerance, the station is
//     under an open dispute, or its chosen row was invalidated.
//   election.leadMarginPct — (leader − runner-up) / total, as a percentage.
//   election.uncertaintyPct — total disagreement spread / total, as a percentage.
//   election.needsReview — any station needs review, or uncertainty could flip
//     the lead.
function marginAndReview(candidates, results, stationMap, tally) {
  const byStation = groupBySid(results);
  const stationFlags = {};
  let totalSpread = 0;
  for (const [sid, list] of byStation) {
    const stationTotal = list.reduce((s, r) => s + Object.values(r.votes || {}).reduce((a, b) => a + (Number(b) || 0), 0), 0);
    const tol = Math.max(5, Math.ceil(0.02 * stationTotal));
    const spread = stationSpread(list);
    totalSpread += spread;
    const chosen = stationMap.get(sid);
    const needsReview = (list.length > 1 && spread > tol) || (chosen && (chosen.invalid || chosen.disputed)) || list.some((r) => r.disputed);
    stationFlags[sid] = { needsReview: !!needsReview, spread, sources: list.length };
  }

  const totals = Object.values(tally).reduce((a, b) => a + (Number(b) || 0), 0);
  const sorted = Object.values(tally).map(Number).sort((a, b) => b - a);
  const lead = sorted.length >= 2 ? sorted[0] - sorted[1] : sorted[0] || 0;
  const leadMarginPct = totals ? +(100 * lead / totals).toFixed(2) : 0;
  const uncertaintyPct = totals ? +(100 * totalSpread / totals).toFixed(2) : 0;
  const anyStationReview = Object.values(stationFlags).some((f) => f.needsReview);
  const needsReview = anyStationReview || (totals > 0 && uncertaintyPct >= leadMarginPct);

  return { stationFlags, leadMarginPct, uncertaintyPct, needsReview };
}

module.exports = {
  METHODS, SELECTORS, perStation,
  latestPerStation, firstPerStation, consensusPerStation, medianPerStation, verifiedLatestPerStation,
  computeTally, reporting, marginAndReview, stationSpread,
};

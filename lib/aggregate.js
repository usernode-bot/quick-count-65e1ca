// Quick Count v3 — aggregation methods.
// All functions are pure (no DB calls) over plain submission rows.
// A submission row: { txHash, stationId, votes (obj), totalVotes, chainTimestamp (ISO), status }

const VALID_METHODS = ['first_report', 'median', 'average', 'consensus', 'manual_review'];

// Returns submissions sorted ascending by chainTimestamp then txHash (oldest first).
function sortAsc(submissions) {
  return [...submissions].sort((a, b) => {
    const ta = String(a.chainTimestamp || '');
    const tb = String(b.chainTimestamp || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return String(a.txHash || '') < String(b.txHash || '') ? -1 : 1;
  });
}

// For a station, group submissions by stationId.
function groupByStation(submissions) {
  const map = new Map();
  for (const s of submissions || []) {
    const sid = s.stationId;
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(s);
  }
  return map;
}

// Sum votes across a result set (map of candidateTxHash -> count).
function sumVotes(votesList) {
  const tally = {};
  for (const votes of votesList) {
    const v = votes && typeof votes === 'object' ? votes : {};
    for (const k of Object.keys(v)) {
      tally[k] = (tally[k] || 0) + (Number(v[k]) || 0);
    }
  }
  return tally;
}

// first_report: for each station, use the chronologically first submission.
function firstReport(submissions) {
  const sorted = sortAsc(submissions);
  const best = new Map();
  for (const s of sorted) {
    if (!best.has(s.stationId)) best.set(s.stationId, s);
  }
  return best;
}

// median: for each station+candidate, compute median across all submissions.
function medianPerStation(submissions) {
  const byStation = groupByStation(submissions);
  const result = new Map();
  for (const [sid, subs] of byStation) {
    const allCands = new Set();
    for (const s of subs) for (const k of Object.keys(s.votes || {})) allCands.add(k);
    const votes = {};
    for (const cid of allCands) {
      const vals = subs.map((s) => Number((s.votes || {})[cid] || 0)).sort((a, b) => a - b);
      const mid = Math.floor(vals.length / 2);
      votes[cid] = vals.length % 2 === 0 ? Math.round((vals[mid - 1] + vals[mid]) / 2) : vals[mid];
    }
    result.set(sid, { txHash: `median-${sid}`, stationId: sid, votes });
  }
  return result;
}

// average: arithmetic mean per station per candidate.
function averagePerStation(submissions) {
  const byStation = groupByStation(submissions);
  const result = new Map();
  for (const [sid, subs] of byStation) {
    const allCands = new Set();
    for (const s of subs) for (const k of Object.keys(s.votes || {})) allCands.add(k);
    const votes = {};
    for (const cid of allCands) {
      const vals = subs.map((s) => Number((s.votes || {})[cid] || 0));
      votes[cid] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    result.set(sid, { txHash: `avg-${sid}`, stationId: sid, votes });
  }
  return result;
}

// consensus: include a station only if >=67% of its submissions agree
// (total vote counts within ±5% of each other). Otherwise marks no_consensus.
function consensusPerStation(submissions) {
  const byStation = groupByStation(submissions);
  const result = new Map();
  for (const [sid, subs] of byStation) {
    if (subs.length === 1) {
      result.set(sid, { ...subs[0], consensus: true });
      continue;
    }
    const totals = subs.map((s) => Object.values(s.votes || {}).reduce((a, b) => a + Number(b), 0));
    const median = [...totals].sort((a, b) => a - b)[Math.floor(totals.length / 2)];
    const threshold = median * 0.05;
    const agreeing = subs.filter((_, i) => Math.abs(totals[i] - median) <= threshold);
    if (agreeing.length / subs.length >= 0.67) {
      // Use first agreeing submission's votes as representative
      result.set(sid, { ...agreeing[0], consensus: true });
    } else {
      result.set(sid, { txHash: `no-consensus-${sid}`, stationId: sid, votes: null, consensus: false, noConsensus: true });
    }
  }
  return result;
}

// Compute overall tally from a resolved Map<stationId, submission>.
function computeTally(candidates, resolvedMap) {
  const tally = {};
  for (const c of candidates || []) tally[c.txHash] = 0;
  for (const s of resolvedMap.values()) {
    if (!s.votes) continue;
    for (const k of Object.keys(s.votes)) {
      tally[k] = (tally[k] || 0) + (Number(s.votes[k]) || 0);
    }
  }
  return tally;
}

function reporting(stations, resolvedMap) {
  let reported = 0;
  for (const s of stations || []) {
    const r = resolvedMap.get(s.id);
    if (r && r.votes !== null) reported++;
  }
  return { reported, total: (stations || []).length };
}

// Main aggregate entry point.
function aggregate(method, submissions, candidates, stations, manualTally) {
  const active = (submissions || []).filter((s) => s.status !== 'revised');

  let resolvedMap;
  let stationDetails = [];

  if (method === 'manual_review') {
    resolvedMap = new Map();
    const tally = manualTally || null;
    const rep = { reported: 0, total: (stations || []).length };
    return { tally, reporting: rep, method, stationDetails: [] };
  }

  if (method === 'first_report') {
    resolvedMap = firstReport(active);
  } else if (method === 'median') {
    resolvedMap = medianPerStation(active);
  } else if (method === 'average') {
    resolvedMap = averagePerStation(active);
  } else if (method === 'consensus') {
    resolvedMap = consensusPerStation(active);
  } else {
    resolvedMap = firstReport(active);
  }

  for (const stn of stations || []) {
    const r = resolvedMap.get(stn.id);
    stationDetails.push({
      stationId: stn.id,
      stationTxHash: stn.txHash,
      name: stn.name,
      region: stn.region,
      reported: !!r,
      noConsensus: r ? !!r.noConsensus : false,
      submitterPubkey: r ? r.submitterPubkey || '' : '',
      votes: r ? r.votes : null,
      status: r ? r.status || 'ok' : null,
    });
  }

  return {
    tally: computeTally(candidates, resolvedMap),
    reporting: reporting(stations, resolvedMap),
    method,
    stationDetails,
  };
}

module.exports = {
  VALID_METHODS,
  firstReport, medianPerStation, averagePerStation, consensusPerStation,
  computeTally, reporting, aggregate,
};

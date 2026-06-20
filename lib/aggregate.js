// Quick Count — Latest-Submission aggregation.
//
// Pure functions over plain result rows so they can be unit-tested without a
// database. A "result row" is { sid, tx_id, votes, tot, inv, created_at(ISO
// string), submitter_pubkey }.

// For each station, keep only its latest submission. Order by created_at then
// tx_id (both lexicographically — ISO timestamps sort chronologically).
// Returns a Map<sid, result>.
function latestPerStation(results) {
  const key = (r) => `${r.created_at || ''}|${r.tx_id || ''}`;
  const best = new Map();
  for (const r of results || []) {
    const cur = best.get(r.sid);
    if (!cur || key(r) > key(cur)) best.set(r.sid, r);
  }
  return best;
}

// Sum votes per candidate across the latest-per-station results.
function computeTally(candidates, latestMap) {
  const tally = {};
  for (const c of candidates || []) tally[c.cid] = 0;
  for (const r of latestMap.values()) {
    const votes = r.votes || {};
    for (const k of Object.keys(votes)) {
      const cid = Number(k);
      const n = Number(votes[k]) || 0;
      if (!(cid in tally)) tally[cid] = 0;
      tally[cid] += n;
    }
  }
  return tally;
}

// Reporting progress: how many stations have at least one submission.
function reporting(stations, latestMap) {
  let reported = 0;
  for (const s of stations || []) if (latestMap.has(s.sid)) reported++;
  return { reported, total: (stations || []).length };
}

module.exports = { latestPerStation, computeTally, reporting };

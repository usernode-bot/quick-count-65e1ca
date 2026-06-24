// Quick Count — Evidence PDF upload verifier (client-side).
//
// Re-derives a dropped Evidence PDF's fingerprint from its embedded canonical
// record (shared serializer in evidence-fingerprint.js) and runs a battery of
// checks: document integrity, internal consistency, and — when a chain source
// is configured — a cross-check against the original on-chain transaction.
// With no readable chain (staging / local-dev / unconfigured deploy) the
// on-chain check is honestly reported as SKIPPED, not failed, yielding the
// "Verified (off-chain only)" verdict.
//
// Exposed as window.QCEvidenceVerify. Pure of DOM — renderVerify() in
// index.html owns the UI and calls verifyFile / verifyFromQuery here.
(function (root) {
  'use strict';
  var FP = root.QCEvidence;

  // ── Browser mirror of lib/memo.js decode(), 'res' branch only ─────────────
  // Kept in lockstep with lib/memo.js the same way QC.res / validateMemo are.
  function decodeResMemo(memoStr) {
    if (typeof memoStr !== 'string' || !memoStr) return null;
    var o;
    try { o = JSON.parse(memoStr); } catch (e) { return null; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (o.app !== 'quickcount' || o.v !== 1 || o.t !== 'res') return null;
    if (!o.eid || !Number.isInteger(o.sid) || o.sid < 1) return null;
    return o; // votes/tot/inv/ev passed through; canonicalRecord normalizes them
  }

  // Mirror of indexer.normalizeTx field-name handling, trimmed to what we need.
  function extractTxId(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var keys = ['id', 'txid', 'txId', 'tx_id', 'hash', 'tx_hash', 'txHash'];
    for (var i = 0; i < keys.length; i++) {
      var v = raw[keys[i]];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  }
  function pickFirst(o, keys) { for (var i = 0; i < keys.length; i++) if (o[keys[i]] != null) return o[keys[i]]; return null; }
  function normalizeTx(raw) {
    var from = pickFirst(raw, ['from_pubkey', 'sender', 'account', 'from']);
    var to = pickFirst(raw, ['destination_pubkey', 'destination', 'to', 'recipient']);
    var createdRaw = pickFirst(raw, ['created_at', 'createdAt', 'timestamp', 'time']);
    return {
      txId: extractTxId(raw),
      from: from == null ? null : String(from),
      to: to == null ? null : String(to),
      memo: raw.memo == null ? null : String(raw.memo),
      createdAt: createdRaw,
    };
  }

  function chainConfigured(cfg) { return !!(cfg && cfg.chainConfigured); }

  // Fetch a single transaction by id from the public explorer proxy. Queries
  // both by sender (account) and recipient and returns the first match, or null.
  function fetchTx(cfg, txId, account, recipient) {
    var base = ((cfg && cfg.explorerApiBase) || '/explorer-api').replace(/\/+$/, '');
    var chain = (cfg && cfg.chainId) || 'usernode';
    var url = base + '/' + encodeURIComponent(chain) + '/transactions';
    var bodies = [];
    if (account) bodies.push({ account: account, limit: 200 });
    if (recipient) bodies.push({ recipient: recipient, limit: 200 });
    if (!bodies.length) bodies.push({ limit: 200 });

    var found = null;
    function tryBody(i) {
      if (i >= bodies.length || found) return Promise.resolve(found);
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bodies[i]),
      }).then(function (r) {
        if (!r.ok) return null;
        return r.json().catch(function () { return null; });
      }).then(function (data) {
        if (data) {
          var list = Array.isArray(data) ? data : (data.transactions || data.txs || data.results || []);
          for (var k = 0; k < list.length; k++) {
            if (extractTxId(list[k]) === txId) { found = list[k]; break; }
          }
        }
        return tryBody(i + 1);
      }).catch(function () { return tryBody(i + 1); });
    }
    return tryBody(0);
  }

  function check(id, label, status, reason) { return { id: id, label: label, status: status, reason: reason || '' }; }

  function sumVotes(rec) { return rec.votes.reduce(function (s, p) { return s + p[1]; }, 0); }

  // Internal consistency: votes + invalid == total (when a total is present).
  function consistencyCheck(rec) {
    if (rec.tot == null) {
      return check('consistency', 'Internal consistency', 'skip', 'No total reported on this result — nothing to reconcile.');
    }
    var sum = sumVotes(rec);
    var inv = rec.inv == null ? 0 : rec.inv;
    if (sum + inv === rec.tot) {
      return check('consistency', 'Internal consistency', 'pass',
        sum + ' valid + ' + inv + ' invalid = ' + rec.tot + ' total.');
    }
    return check('consistency', 'Internal consistency', 'fail',
      'Votes (' + sum + ') + invalid (' + inv + ') = ' + (sum + inv) + ', but total reported is ' + rec.tot + '.');
  }

  // On-chain cross-check. Returns a Promise<check>.
  function onChainCheck(cfg, rec, expectedFp) {
    if (!chainConfigured(cfg)) {
      return Promise.resolve(check('onchain', 'On the blockchain', 'skip',
        'No live chain source is configured in this environment, so the on-chain cross-check was not run.'));
    }
    if (!rec.txId) {
      return Promise.resolve(check('onchain', 'On the blockchain', 'fail', 'The record carries no transaction id to look up.'));
    }
    return fetchTx(cfg, rec.txId, rec.observer, rec.org).then(function (raw) {
      if (!raw) {
        return check('onchain', 'On the blockchain', 'skip',
          'Transaction ' + rec.txId.slice(0, 12) + '… was not found on the chain within the lookup window.');
      }
      var norm = normalizeTx(raw);
      var env = decodeResMemo(norm.memo);
      if (!env) {
        return check('onchain', 'On the blockchain', 'fail', 'The on-chain transaction is not a valid Quick Count result memo.');
      }
      var chainRec = FP.canonicalRecord({
        eid: env.eid, sid: env.sid, observer: norm.from, org: norm.to,
        txId: rec.txId, createdAt: norm.createdAt,
        votes: env.votes, tot: env.tot, inv: env.inv, ev: env.ev,
      });
      return FP.fingerprint(chainRec).then(function (chainFp) {
        if (norm.from !== rec.observer) {
          return check('onchain', 'On the blockchain', 'fail',
            'On-chain submitter (' + String(norm.from).slice(0, 12) + '…) differs from the document observer.');
        }
        if (norm.to !== rec.org) {
          return check('onchain', 'On the blockchain', 'fail',
            'On-chain recipient differs from the document organization.');
        }
        if (chainFp === expectedFp) {
          return check('onchain', 'On the blockchain', 'pass',
            'Matches the on-chain result exactly (tx ' + rec.txId.slice(0, 12) + '…).');
        }
        return check('onchain', 'On the blockchain', 'fail',
          'The document does not match what was recorded on-chain for this transaction.');
      });
    });
  }

  function placeholderChecks(rec) {
    var out = [];
    out.push(rec.merkle && rec.merkle.root
      ? check('merkle', 'Merkle inclusion', 'skip', 'Merkle root present but proof verification is not yet implemented.')
      : check('merkle', 'Merkle inclusion', 'skip', 'Not yet anchored — reserved for a future per-election Merkle root.'));
    out.push(rec.zk && rec.zk.proof
      ? check('zk', 'Zero-knowledge proof', 'skip', 'ZK proof present but verification is not yet implemented.')
      : check('zk', 'Zero-knowledge proof', 'skip', 'Not yet anchored — reserved for future ZK commitments.'));
    out.push(rec.cid
      ? check('cid', 'Content archive (IPFS)', 'skip', 'CID present but content fetch is not yet implemented.')
      : check('cid', 'Content archive (IPFS)', 'skip', 'Not yet anchored — reserved for future IPFS archival.'));
    return out;
  }

  function verdictFrom(checks) {
    var byId = {};
    checks.forEach(function (c) { byId[c.id] = c; });
    var core = ['integrity', 'consistency', 'onchain'];
    for (var i = 0; i < core.length; i++) {
      if (byId[core[i]] && byId[core[i]].status === 'fail') return 'fail';
    }
    if (byId.onchain && byId.onchain.status !== 'pass') return 'offchain';
    return 'verified';
  }

  // Core verification given a canonical record + an optional independently
  // claimed fingerprint (from the PDF's metadata/visible text, or a QR's fp).
  function verifyRecord(rec, claimedFp, cfg) {
    rec = FP.canonicalRecord(rec);
    return FP.fingerprint(rec).then(function (computedFp) {
      var checks = [];
      // Check A — document integrity.
      if (claimedFp) {
        if (computedFp === claimedFp) {
          checks.push(check('integrity', 'Document integrity', 'pass', 'The page contents hash to the fingerprint shown on the document.'));
        } else {
          checks.push(check('integrity', 'Document integrity', 'fail',
            'The document has been altered: its contents hash to ' + computedFp.slice(0, 12) + '… but it claims ' + claimedFp.slice(0, 12) + '….'));
        }
      } else {
        checks.push(check('integrity', 'Document integrity', 'pass',
          'Fingerprint recomputed from the embedded record (' + computedFp.slice(0, 12) + '…). No separate fingerprint claim was found to compare against.'));
      }
      // Check B — internal consistency.
      checks.push(consistencyCheck(rec));
      // Check C — on-chain, then D/E/F placeholders.
      return onChainCheck(cfg, rec, claimedFp || computedFp).then(function (onchain) {
        checks.push(onchain);
        placeholderChecks(rec).forEach(function (c) { checks.push(c); });
        return { record: rec, fingerprint: computedFp, claimedFp: claimedFp || null, checks: checks, verdict: verdictFrom(checks) };
      });
    });
  }

  // Read a File as a latin1 (binary) string so the embedded marker survives.
  function readBinary(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(new Error('Could not read file')); };
      // readAsBinaryString keeps bytes 1:1 so base64url + hex survive intact.
      fr.readAsBinaryString(file);
    });
  }

  // Verify a dropped/selected Evidence PDF.
  function verifyFile(file, cfg) {
    return readBinary(file).then(function (text) {
      var rec = FP.extractFromText(text);
      if (!rec) {
        return { error: 'no-marker', message: 'No embedded Quick Count evidence record was found in this PDF.' };
      }
      // The generator writes "subject: fingerprint:<fp>" and prints the
      // fingerprint visibly; either provides an independent claim for Check A.
      var m = text.match(/fingerprint:([0-9a-fA-F]{64})/);
      var claimedFp = m ? m[1].toLowerCase() : null;
      return verifyRecord(rec, claimedFp, cfg);
    });
  }

  // Verify straight from a QR deep-link (?fp & ?tx), no file needed. Requires a
  // configured chain — otherwise there is nothing to check the claim against.
  function verifyFromQuery(params, cfg) {
    var fp = (params.fp || '').toLowerCase();
    var txId = params.tx || '';
    if (!/^[0-9a-f]{64}$/.test(fp) || !txId) {
      return Promise.resolve({ error: 'bad-query', message: 'The verification link is missing a fingerprint or transaction id.' });
    }
    if (!chainConfigured(cfg)) {
      var skipped = [
        check('integrity', 'Document integrity', 'skip', 'No document was provided — drop the Evidence PDF to check its integrity.'),
        check('consistency', 'Internal consistency', 'skip', 'No document was provided.'),
        check('onchain', 'On the blockchain', 'skip', 'No live chain source is configured in this environment.'),
      ];
      return Promise.resolve({ fingerprint: fp, claimedFp: fp, fromQuery: true, checks: skipped, verdict: 'offchain' });
    }
    // Reconstruct the record from the on-chain transaction, then compare its
    // fingerprint to the QR's claim — a full chain verification with no file.
    return fetchTx(cfg, txId, null, null).then(function (raw) {
      var checks = [
        check('integrity', 'Document integrity', 'skip', 'No document was provided — verifying the QR claim against the chain.'),
        check('consistency', 'Internal consistency', 'skip', 'No document was provided.'),
      ];
      if (!raw) {
        checks.push(check('onchain', 'On the blockchain', 'skip', 'Transaction ' + txId.slice(0, 12) + '… was not found on the chain.'));
        return { fingerprint: fp, claimedFp: fp, fromQuery: true, checks: checks, verdict: 'offchain' };
      }
      var norm = normalizeTx(raw);
      var env = decodeResMemo(norm.memo);
      if (!env) {
        checks.push(check('onchain', 'On the blockchain', 'fail', 'The on-chain transaction is not a valid Quick Count result.'));
        return { fingerprint: fp, claimedFp: fp, fromQuery: true, checks: checks, verdict: 'fail' };
      }
      var chainRec = FP.canonicalRecord({
        eid: env.eid, sid: env.sid, observer: norm.from, org: norm.to,
        txId: txId, createdAt: norm.createdAt, votes: env.votes, tot: env.tot, inv: env.inv, ev: env.ev,
      });
      return FP.fingerprint(chainRec).then(function (chainFp) {
        checks.push(chainFp === fp
          ? check('onchain', 'On the blockchain', 'pass', 'The QR claim matches the on-chain result (tx ' + txId.slice(0, 12) + '…).')
          : check('onchain', 'On the blockchain', 'fail', 'The QR fingerprint does not match what is recorded on-chain.'));
        placeholderChecks(chainRec).forEach(function (c) { checks.push(c); });
        return { fingerprint: fp, claimedFp: fp, fromQuery: true, record: chainRec, checks: checks, verdict: verdictFrom(checks) };
      });
    });
  }

  root.QCEvidenceVerify = {
    verifyFile: verifyFile,
    verifyRecord: verifyRecord,
    verifyFromQuery: verifyFromQuery,
    decodeResMemo: decodeResMemo,
    normalizeTx: normalizeTx,
  };
})(typeof self !== 'undefined' ? self : this);

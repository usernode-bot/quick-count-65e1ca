// Quick Count — client-side Evidence PDF generator.
//
// Builds a one-page, self-verifying audit PDF for a confirmed polling-station
// result ENTIRELY in the browser — nothing is uploaded and no server signs it.
// The fingerprint and canonical record come from the shared, frozen serializer
// (evidence-fingerprint.js), so a PDF this module produces verifies byte-for-
// byte against evidence-verify.js.
//
// Depends on two CDN libraries loaded by index.html:
//   • jsPDF              → window.jspdf.jsPDF
//   • qrcode-generator   → window.qrcode
// Both are optional: when either is missing (offline), available() returns
// false and the caller disables the Download button with a non-blocking notice
// (mirroring the app's tolerance of an unreachable bridge).
//
// Exposed as window.QCEvidencePDF.
(function (root) {
  'use strict';
  var FP = root.QCEvidence;

  function jsPDFCtor() {
    return (root.jspdf && root.jspdf.jsPDF) ? root.jspdf.jsPDF : null;
  }
  function available() { return !!jsPDFCtor() && typeof root.qrcode === 'function' && !!FP; }

  // Build canonical-record INPUT from an electionDetail station row + election.
  // The station row (indexer.electionDetail → stations[]) carries the immutable
  // result fields: resultTx, observer, votes{cid:n}, tot, inv, ev, at.
  function recordInputFromStation(detail, station) {
    var el = (detail && detail.election) || {};
    return {
      eid: el.eid,
      sid: station.sid,
      observer: station.observer,
      org: el.orgAddr,
      txId: station.resultTx,
      createdAt: station.at,
      votes: station.votes || {},
      tot: station.tot,
      inv: station.inv,
      ev: station.ev || null,
      // Forward-compatible placeholders (null today).
      cid: null, merkle: {}, zk: {},
    };
  }

  // QR deep link: opens the Verify screen pre-loaded with this result so a phone
  // can verify straight from chain even without the file.
  function verifyUrl(origin, rec) {
    var base = (origin || '') + '/#/verify';
    return base + '?fp=' + encodeURIComponent(rec.fingerprint) +
      '&tx=' + encodeURIComponent(rec.record.txId) +
      '&eid=' + encodeURIComponent(rec.record.eid) +
      '&sid=' + encodeURIComponent(rec.record.sid) + '&v=1';
  }

  // Render a QR (qrcode-generator) to a black/white PNG data URL.
  function qrDataUrl(text) {
    var qr = root.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    // cellSize 4, margin 4 → crisp at the ~34mm we place it.
    return qr.createDataURL(4, 4);
  }

  // Compute fingerprint + canonical record, then resolve with everything the
  // page render and the embedded carriers need.
  function prepare(detail, station) {
    var input = recordInputFromStation(detail, station);
    var record = FP.canonicalRecord(input);
    return FP.fingerprint(record).then(function (fingerprint) {
      return { record: record, fingerprint: fingerprint };
    });
  }

  // Display labels (NOT part of the cryptographic proof) pulled from detail.
  function labels(detail, station) {
    var el = (detail && detail.election) || {};
    var cands = (detail && detail.candidates) || [];
    var nameOf = {};
    cands.forEach(function (c) { nameOf[c.cid] = c.name; });
    return {
      electionName: el.name || el.eid || '—',
      orgName: el.orgName || el.orgAddr || '—',
      stationName: station.name || ('Station ' + station.sid),
      stationLabel: station.label || '',
      candName: function (cid) { return nameOf[cid] || ('Candidate ' + cid); },
    };
  }

  function shortFp(fp) { return (fp || '').slice(0, 12); }

  function safeFilename(s) {
    return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'evidence';
  }

  // Generate + trigger download. Returns a Promise resolving to
  // { fingerprint, record, filename }. Throws if the libraries are unavailable.
  function generate(detail, station, opts) {
    opts = opts || {};
    if (!available()) return Promise.reject(new Error('PDF libraries unavailable'));
    var JsPDF = jsPDFCtor();
    var lbl = labels(detail, station);

    return prepare(detail, station).then(function (prep) {
      var rec = prep.record, fp = prep.fingerprint;
      var origin = opts.origin || (root.location ? root.location.origin : '');
      var url = verifyUrl(origin, { record: rec, fingerprint: fp });

      var doc = new JsPDF({ unit: 'mm', format: 'a4' });
      var W = 210, M = 16, x = M, y = 20;

      doc.setFont('helvetica', 'bold'); doc.setFontSize(18);
      doc.text('Quick Count — Evidence', x, y); y += 7;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      doc.setTextColor(110);
      doc.text('Cryptographically verifiable polling-station result', x, y);
      doc.setTextColor(0); y += 9;

      // Identity block (display only).
      doc.setFontSize(11);
      function kv(k, v) {
        doc.setFont('helvetica', 'bold'); doc.text(k, x, y);
        doc.setFont('helvetica', 'normal');
        doc.text(doc.splitTextToSize(String(v == null ? '—' : v), 120), x + 34, y);
        y += 6.5;
      }
      kv('Election', lbl.electionName);
      kv('Organization', lbl.orgName);
      kv('Station', lbl.stationName + (lbl.stationLabel ? '  (' + lbl.stationLabel + ')' : ''));
      kv('Observer', rec.observer || '—');
      kv('Recorded at', rec.createdAt || '—');
      doc.setTextColor(120); doc.setFontSize(8);
      doc.text('Names above are display labels and are not part of the cryptographic proof.', x, y);
      doc.setTextColor(0); doc.setFontSize(11); y += 7;

      // Results table.
      doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
      doc.text('Reported result', x, y); y += 6;
      doc.setFontSize(10);
      doc.setFillColor(238, 240, 245);
      doc.rect(x, y - 4, W - 2 * M, 7, 'F');
      doc.text('Candidate', x + 2, y); doc.text('Votes', W - M - 24, y, { align: 'left' });
      y += 5;
      doc.setFont('helvetica', 'normal');
      rec.votes.forEach(function (p) {
        doc.text(doc.splitTextToSize(lbl.candName(p[0]), 120), x + 2, y);
        doc.text(String(p[1]), W - M - 24, y);
        y += 6;
      });
      doc.setDrawColor(210); doc.line(x, y - 2, W - M, y - 2); y += 2;
      doc.setFont('helvetica', 'bold');
      doc.text('Total valid', x + 2, y); doc.text(rec.tot == null ? '—' : String(rec.tot), W - M - 24, y); y += 6;
      doc.text('Invalid / blank', x + 2, y); doc.text(rec.inv == null ? '—' : String(rec.inv), W - M - 24, y); y += 8;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
      if (rec.ev) {
        doc.setTextColor(110);
        doc.text('Tally-sheet hash (SHA-256): ' + rec.ev, x, y);
        doc.setTextColor(0);
        y += 6;
      }

      // On-chain reference.
      doc.setFontSize(11); doc.setFont('helvetica', 'bold');
      doc.text('Blockchain reference', x, y); y += 6;
      doc.setFont('courier', 'normal'); doc.setFontSize(8);
      doc.text('tx: ' + (rec.txId || '—'), x, y); y += 5;
      doc.text('eid: ' + (rec.eid || '—'), x, y); y += 8;

      // Fingerprint — bold, full width.
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
      doc.text('Document fingerprint (SHA-256)', x, y); y += 6;
      doc.setFont('courier', 'bold'); doc.setFontSize(10);
      doc.splitTextToSize(fp, W - 2 * M).forEach(function (line) { doc.text(line, x, y); y += 5; });
      y += 4;

      // QR (right side) + how-to-verify footer (left).
      try {
        var png = qrDataUrl(url);
        doc.addImage(png, 'PNG', W - M - 34, y, 34, 34);
      } catch (e) { /* QR is a fallback carrier; the metadata marker is primary */ }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(90);
      var how = doc.splitTextToSize(
        'How to verify: open Quick Count → Verify and drop this PDF, or scan the QR to ' +
        'check it against the blockchain. Verification recomputes the fingerprint from ' +
        'the embedded record; any edit to the numbers above breaks the match.', 120);
      doc.text(how, x, y + 4);
      doc.setTextColor(0);

      // ── Embedded machine-readable record (primary carrier) ──
      // Stash QCEV1.<base64url(record)> in the PDF Keywords so the verifier can
      // regex it straight out of the bytes without a PDF parser.
      var marker = FP.encodeRecord(rec);
      doc.setProperties({
        title: 'Quick Count Evidence — ' + lbl.stationName,
        subject: 'fingerprint:' + fp,
        author: 'Quick Count',
        keywords: marker,
      });

      var filename = 'evidence_' + safeFilename(lbl.electionName) + '_' +
        safeFilename(lbl.stationName) + '_' + shortFp(fp) + '.pdf';
      doc.save(filename);
      return { fingerprint: fp, record: rec, filename: filename, marker: marker, url: url };
    });
  }

  root.QCEvidencePDF = {
    available: available,
    generate: generate,
    prepare: prepare,
    recordInputFromStation: recordInputFromStation,
    verifyUrl: verifyUrl,
  };
})(typeof self !== 'undefined' ? self : this);

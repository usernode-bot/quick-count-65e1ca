// Quick Count — client-side Working Tally PDF generator.
//
// Builds a one-page A4 summary PDF for an election's off-chain working tally
// ENTIRELY in the browser — no server, no uploads, no auth needed.
//
// Depends on jsPDF loaded before this file:
//   • jsPDF → window.jspdf.jsPDF
// QuickCountInline (window.QuickCountInline) must also be present.
//
// Callers pass their own language code via opts.lang (index.html forwards
// App.lang, dashboard.html has no i18n so it forwards the 'en' fallback) so
// the "Exported" stamp renders in the viewer's language via
// Intl.DateTimeFormat instead of a fixed English month-name format.
//
// Exposed as window.QCResultsPDF.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(null);
  else root.QCResultsPDF = factory(root);
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  function jsPDFCtor() {
    return (root && root.jspdf && root.jspdf.jsPDF) ? root.jspdf.jsPDF : null;
  }

  function available() {
    return !!jsPDFCtor() && !!(root && root.QuickCountInline);
  }

  function safeFilename(s) {
    return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'results';
  }

  // BCP-47 locale tag per app language code (see index.html's LANGS).
  var LOCALE_MAP = {
    en: 'en-US', id: 'id-ID', 'zh-Hans': 'zh-Hans-CN', es: 'es-ES',
    hi: 'hi-IN', ar: 'ar-EG', fr: 'fr-FR',
  };

  function fmtTimestamp(iso, lang) {
    try {
      var d = new Date(iso);
      var locale = LOCALE_MAP[lang] || LOCALE_MAP.en;
      return new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(d);
    } catch (e) { return iso || ''; }
  }

  function fmtDate(iso) {
    try {
      var d = new Date(iso);
      var m = d.getUTCMonth() + 1;
      var dd = d.getUTCDate();
      return d.getUTCFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (dd < 10 ? '0' : '') + dd;
    } catch (e) { return ''; }
  }

  // Generate + trigger browser download.
  // opts: { electionName, candidates, totals, shares, stationReported, stationTotal, exportedAt, lang }
  //   candidates  — array of { key, name } (QuickCountInline.CANDIDATES)
  //   totals      — { key: number } from aggregateVotes()
  //   shares      — { key: number } from voteShares()
  //   exportedAt  — ISO timestamp string, stamped by the caller at click time
  //   lang        — app language code; controls the "Exported" stamp's locale
  function generate(opts) {
    if (!available()) throw new Error('PDF libraries unavailable');
    opts = opts || {};
    var JsPDF = jsPDFCtor();
    var candidates = opts.candidates || [];
    var totals = opts.totals || {};
    var shares = opts.shares || {};
    var stationReported = Number(opts.stationReported) || 0;
    var stationTotal = Number(opts.stationTotal) || stationReported;
    var exportedAt = opts.exportedAt || '';
    var electionName = opts.electionName || 'Election';
    var lang = opts.lang || 'en';

    var grand = candidates.reduce(function (s, c) { return s + (Number(totals[c.key]) || 0); }, 0);

    var ranked = candidates
      .map(function (c, i) {
        return { c: c, i: i, votes: Number(totals[c.key]) || 0, share: Number(shares[c.key]) || 0 };
      })
      .sort(function (a, b) { return (b.votes - a.votes) || (a.i - b.i); });

    var doc = new JsPDF({ unit: 'mm', format: 'a4' });
    var W = 210, M = 16, x = M, y = 20;

    // Header
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(18);
    doc.text('Quick Count — Working Tally', x, y);
    y += 8;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(13);
    doc.setTextColor(50);
    doc.text(doc.splitTextToSize(electionName, W - 2 * M)[0], x, y);
    doc.setTextColor(0);
    y += 8;

    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('Exported ' + fmtTimestamp(exportedAt, lang), x, y);
    doc.setTextColor(0);
    y += 5;

    doc.setFontSize(10);
    doc.setTextColor(90);
    doc.text(stationReported + ' of ' + stationTotal + ' station' + (stationTotal === 1 ? '' : 's') + ' entered', x, y);
    doc.setTextColor(0);
    y += 12;

    // Results table
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text('Results', x, y);
    y += 7;

    var colRank = x;
    var colName = x + 14;
    var colVotes = W - M - 28;
    var colShare = W - M;

    // Table header
    doc.setFontSize(10);
    doc.setFillColor(228, 231, 240);
    doc.rect(colRank, y - 5, W - 2 * M, 7, 'F');
    doc.setFont('helvetica', 'bold');
    doc.text('Rank', colRank + 1, y);
    doc.text('Candidate', colName, y);
    doc.text('Votes', colVotes, y, { align: 'right' });
    doc.text('Share %', colShare, y, { align: 'right' });
    y += 7;

    // Data rows
    doc.setFont('helvetica', 'normal');
    ranked.forEach(function (r, idx) {
      if (idx % 2 === 0) {
        doc.setFillColor(248, 249, 252);
        doc.rect(colRank, y - 5, W - 2 * M, 7, 'F');
      }
      doc.text(String(idx + 1), colRank + 2, y);
      doc.text(doc.splitTextToSize(String(r.c.name), 80)[0], colName, y);
      doc.text(r.votes.toLocaleString(), colVotes, y, { align: 'right' });
      doc.text(r.share + '%', colShare, y, { align: 'right' });
      y += 7;
    });

    // Total row
    doc.setDrawColor(180);
    doc.line(colRank, y - 2, W - M, y - 2);
    y += 4;
    doc.setFont('helvetica', 'bold');
    doc.text('Total', colName, y);
    doc.text(grand.toLocaleString(), colVotes, y, { align: 'right' });
    y += 16;

    // Footer note
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text('Off-chain working count entered by the organizer. Not an official certified result.', x, y);
    doc.setTextColor(0);

    var dateStr = fmtDate(exportedAt);
    var filename = safeFilename(electionName) + ' - working tally' + (dateStr ? ' ' + dateStr : '') + '.pdf';
    doc.save(filename);
  }

  return {
    available: available,
    generate: generate,
    fmtTimestamp: fmtTimestamp,
    fmtDate: fmtDate,
  };
});

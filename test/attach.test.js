'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const {
  validateImageUpload, isKind, magicMatches, MAX_BYTES,
  validateBallotProof, MIN_BALLOT_BYTES, MAX_PDF_BYTES,
} = require('../lib/attach');

// Minimal valid signatures for each allowed type.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP_SIG = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test('accepts each allowed mime with matching magic bytes', () => {
  assert.strictEqual(validateImageUpload('image/png', PNG_SIG).ok, true);
  assert.strictEqual(validateImageUpload('image/jpeg', JPEG_SIG).ok, true);
  assert.strictEqual(validateImageUpload('image/webp', WEBP_SIG).ok, true);
});

test('rejects an unknown / disallowed mime', () => {
  const r = validateImageUpload('image/gif', PNG_SIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});

test('rejects empty or non-buffer data', () => {
  assert.strictEqual(validateImageUpload('image/png', Buffer.alloc(0)).ok, false);
  assert.strictEqual(validateImageUpload('image/png', 'not-a-buffer').ok, false);
});

test('rejects an oversize buffer with a 413 hint', () => {
  const big = Buffer.alloc(MAX_BYTES + 1);
  big.set(PNG_SIG, 0); // valid signature, but too large
  const r = validateImageUpload('image/png', big);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 413);
});

test('rejects a payload whose magic bytes do not match the declared mime', () => {
  // Declares PNG but carries JPEG bytes.
  const r = validateImageUpload('image/png', JPEG_SIG);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});

test('magicMatches is strict about the signature', () => {
  assert.strictEqual(magicMatches('image/png', PNG_SIG), true);
  assert.strictEqual(magicMatches('image/png', JPEG_SIG), false);
  assert.strictEqual(magicMatches('image/webp', Buffer.from([0x52, 0x49, 0x46, 0x46])), false); // too short
});

test('isKind allowlists only the two known kinds', () => {
  assert.strictEqual(isKind('cand_avatar'), true);
  assert.strictEqual(isKind('station_c1'), true);
  assert.strictEqual(isKind('evil'), false);
});

// ── Ballot-proof validation ─────────────────────────────────────────────────
// A PNG ≥ MIN_BALLOT_BYTES with the given IHDR dimensions.
function bigPng(w, h) {
  const buf = Buffer.alloc(MIN_BALLOT_BYTES + 256);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(13, 8); buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(w, 16); buf.writeUInt32BE(h, 20);
  return buf;
}
// A minimal but well-formed PDF (header, one page object, %%EOF) padded to size.
function bigPdf() {
  const head = '%PDF-1.4\n1 0 obj<< /Type /Page >>endobj\n';
  const tail = '\n%%EOF';
  const pad = ' '.repeat(MIN_BALLOT_BYTES + 64 - head.length - tail.length);
  return Buffer.from(head + pad + tail, 'latin1');
}

test('ballot proof accepts a large, high-res PNG', () => {
  const r = validateBallotProof('image/png', bigPng(800, 600));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.info.width, 800);
  assert.strictEqual(r.info.height, 600);
});

test('ballot proof accepts a well-formed PDF and counts a page', () => {
  const r = validateBallotProof('application/pdf', bigPdf());
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.info.kind, 'pdf');
  assert.ok(r.info.pages >= 1);
});

test('ballot proof rejects an unsupported type (e.g. gif)', () => {
  const r = validateBallotProof('image/gif', bigPng(800, 600));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});

test('ballot proof rejects a renamed file (magic mismatch)', () => {
  // Declares PDF but carries PNG bytes.
  const r = validateBallotProof('application/pdf', bigPng(800, 600));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});

test('ballot proof rejects a too-small thumbnail', () => {
  const tiny = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0]);
  const r = validateBallotProof('image/png', tiny);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
});

test('ballot proof rejects a low-resolution scan', () => {
  const r = validateBallotProof('image/png', bigPng(120, 90));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 400);
  assert.match(r.error, /resolution/i);
});

test('ballot proof rejects an oversize PDF with a 413 hint', () => {
  const big = Buffer.alloc(MAX_PDF_BYTES + 1);
  big.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // %PDF- so it passes the magic check
  const r = validateBallotProof('application/pdf', big);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 413);
});

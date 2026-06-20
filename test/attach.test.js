'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { validateImageUpload, isKind, magicMatches, MAX_BYTES } = require('../lib/attach');

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

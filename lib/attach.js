// Quick Count — off-chain image attachment validation.
//
// Pure, dependency-free helpers for validating candidate-avatar and
// station-C1-scan image uploads. Kept in lib/ (like lib/memo.js) so the same
// rules can be unit-tested without a database or HTTP layer.
//
// IMPORTANT: attachments are OFF-CHAIN auxiliary data. Unlike every other
// record in this app they are not signed, not on-chain, and not reproducible
// from the chain. They are display/audit aids only, never part of the
// verifiable tally.

// Allowed image MIME types → magic-byte signature checks.
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Max decoded image size (~2 MB).
const MAX_BYTES = 2 * 1024 * 1024;

// Attachment kinds and the id they reference.
const KINDS = new Set(['cand_avatar', 'station_c1']);

function isKind(k) {
  return KINDS.has(k);
}

// Confirm the leading bytes of `buf` match the declared `mime`. Guards against
// a mislabeled or non-image payload sneaking past the MIME allowlist.
function magicMatches(mime, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return false;
  if (mime === 'image/png') {
    return buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
      && buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a;
  }
  if (mime === 'image/jpeg') {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }
  if (mime === 'image/webp') {
    // "RIFF" .... "WEBP"
    return buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
      && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50;
  }
  return false;
}

// Validate an image upload. Returns { ok: true } or
// { ok: false, status, error } where status is an HTTP-style hint
// (400 bad request, 413 too large).
function validateImageUpload(mime, buf) {
  if (typeof mime !== 'string' || !ALLOWED_MIME.has(mime)) {
    return { ok: false, status: 400, error: 'Unsupported image type (allowed: PNG, JPEG, WebP)' };
  }
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, status: 400, error: 'Empty or invalid image data' };
  }
  if (buf.length > MAX_BYTES) {
    return { ok: false, status: 413, error: 'Image too large (max 2 MB)' };
  }
  if (!magicMatches(mime, buf)) {
    return { ok: false, status: 400, error: 'Image contents do not match the declared type' };
  }
  return { ok: true };
}

module.exports = { ALLOWED_MIME, MAX_BYTES, KINDS, isKind, magicMatches, validateImageUpload };

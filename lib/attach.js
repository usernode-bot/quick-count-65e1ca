// Quick Count — off-chain image attachment validation.
//
// Pure, dependency-free helpers for validating candidate-avatar and
// station-C1-scan image uploads, plus the richer ballot-proof validator used
// by the guided ballot-proof upload flow. Kept in lib/ (like lib/memo.js) so
// the same rules can be unit-tested without a database or HTTP layer.
//
// IMPORTANT: attachments are OFF-CHAIN auxiliary data. Unlike every other
// record in this app they are not signed, not on-chain, and not reproducible
// from the chain. They are display/audit aids only, never part of the
// verifiable tally.

// Allowed image MIME types → magic-byte signature checks (avatars + C1 scans).
const ALLOWED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp']);

// Ballot proofs additionally accept PDF (a scanned count form is commonly a PDF).
const BALLOT_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf']);

// Max decoded image size (~2 MB) for the image-only attachments path.
const MAX_BYTES = 2 * 1024 * 1024;

// Ballot-proof size band. Below the floor it's too small to be a real scan;
// images cap at 2 MB, PDFs at 8 MB (raise the route parser limit to match).
const MIN_BALLOT_BYTES = 8 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_PDF_BYTES = 8 * 1024 * 1024;

// A real ballot photo/scan should be at least this many pixels on its long
// edge — rejects tiny thumbnails that couldn't be audited.
const MIN_LONG_EDGE = 600;

// Attachment kinds and the id they reference.
const KINDS = new Set(['cand_avatar', 'station_c1']);

function isKind(k) {
  return KINDS.has(k);
}

// Confirm the leading bytes of `buf` match the declared `mime`. Guards against
// a mislabeled or non-image payload sneaking past the MIME allowlist.
function magicMatches(mime, buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 5) return false;
  if (mime === 'application/pdf') {
    // "%PDF-"
    return buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d;
  }
  if (buf.length < 12) return false;
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

// Best-effort intrinsic dimensions from a decoded image buffer, by parsing the
// container header only (no image library). Returns { width, height } or null
// when it can't be determined — callers treat unknown dims as "don't block".
function imageDimensions(mime, buf) {
  try {
    if (mime === 'image/png') {
      if (buf.length < 24) return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (mime === 'image/jpeg') {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) { off++; continue; }
        const marker = buf[off + 1];
        // SOF0..SOF15 carry frame dimensions; skip DHT(C4)/JPG(C8)/DAC(CC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) };
        }
        if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { off += 2; continue; }
        const len = buf.readUInt16BE(off + 2);
        if (len < 2) break;
        off += 2 + len;
      }
      return null;
    }
    if (mime === 'image/webp') {
      if (buf.length < 30) return null;
      const fourcc = buf.toString('ascii', 12, 16);
      if (fourcc === 'VP8X') {
        const w = 1 + ((buf[24] | (buf[25] << 8) | (buf[26] << 16)) & 0xffffff);
        const h = 1 + ((buf[27] | (buf[28] << 8) | (buf[29] << 16)) & 0xffffff);
        return { width: w, height: h };
      }
      if (fourcc === 'VP8 ') {
        return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fourcc === 'VP8L') {
        const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
        return {
          width: 1 + (((b1 & 0x3f) << 8) | b0),
          height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)),
        };
      }
      return null;
    }
  } catch { return null; }
  return null;
}

// Lightweight PDF sanity: count page objects and confirm an end-of-file marker.
// Not a full parser — enough to reject a truncated or page-less document.
function pdfInfo(buf) {
  const text = buf.toString('latin1');
  const hasEof = text.includes('%%EOF');
  const matches = text.match(/\/Type\s*\/Page[^s]/g);
  const pages = matches ? matches.length : (text.includes('/Page') ? 1 : 0);
  return { pages, hasEof };
}

// Validate a ballot-proof upload (JPG / PNG / WebP / PDF). Document-sanity only
// — NOT OCR/ML ballot recognition: it confirms the file is really the declared
// type, isn't empty/truncated, is large/clear enough to be a real scan, and (for
// PDFs) has a readable page. Returns { ok, status?, error?, info } where info is
// { kind, bytes, width?, height?, pages? }.
function validateBallotProof(mime, buf) {
  if (typeof mime !== 'string' || !BALLOT_MIME.has(mime)) {
    return { ok: false, status: 400, error: 'Unsupported file type (allowed: JPG, PNG, WebP, PDF)', info: {} };
  }
  if (!Buffer.isBuffer(buf) || buf.length === 0) {
    return { ok: false, status: 400, error: 'Empty or invalid file data', info: {} };
  }
  if (!magicMatches(mime, buf)) {
    return { ok: false, status: 400, error: 'File contents do not match the declared type — is this a renamed file?', info: {} };
  }
  const isPdf = mime === 'application/pdf';
  const info = { kind: isPdf ? 'pdf' : 'image', bytes: buf.length };
  if (buf.length < MIN_BALLOT_BYTES) {
    return { ok: false, status: 400, error: 'File looks too small to be a real ballot scan', info };
  }
  const max = isPdf ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (buf.length > max) {
    return { ok: false, status: 413, error: isPdf ? 'PDF too large (max 8 MB)' : 'Image too large (max 2 MB)', info };
  }
  if (isPdf) {
    const pdf = pdfInfo(buf);
    info.pages = pdf.pages;
    if (!pdf.hasEof || pdf.pages < 1) {
      return { ok: false, status: 400, error: 'PDF appears truncated or has no readable page', info };
    }
  } else {
    const dim = imageDimensions(mime, buf);
    if (dim && dim.width && dim.height) {
      info.width = dim.width;
      info.height = dim.height;
      if (Math.max(dim.width, dim.height) < MIN_LONG_EDGE) {
        return { ok: false, status: 400, error: 'Scan resolution too low (needs a clearer photo)', info };
      }
    }
  }
  return { ok: true, info };
}

module.exports = {
  ALLOWED_MIME, BALLOT_MIME, MAX_BYTES, MIN_BALLOT_BYTES, MAX_IMAGE_BYTES, MAX_PDF_BYTES, MIN_LONG_EDGE,
  KINDS, isKind, magicMatches, validateImageUpload,
  imageDimensions, pdfInfo, validateBallotProof,
};

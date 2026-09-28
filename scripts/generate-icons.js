#!/usr/bin/env node
// Renders the Quick Count icon (a bold white tally mark on solid blue)
// into public/ as PNGs plus a multi-size favicon.ico. No dependencies:
// shapes are anti-aliased capsules, encoded with node's zlib.
//
//   node scripts/generate-icons.js
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [0x25, 0x63, 0xeb]; // blue-600
const FG = [0xff, 0xff, 0xff];
const R = 0.042; // stroke half-width, in units of the icon's side

// Four vertical strokes crossed by a rising diagonal fifth.
const STROKES = [
  [0.305, 0.265, 0.305, 0.735],
  [0.435, 0.265, 0.435, 0.735],
  [0.565, 0.265, 0.565, 0.735],
  [0.695, 0.265, 0.695, 0.735],
  [0.195, 0.665, 0.805, 0.335],
];

function distToSegment(px, py, [ax, ay, bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return Math.sqrt(cx * cx + cy * cy);
}

function render(size) {
  const SS = 4;
  const px = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (STROKES.some((s) => distToSegment(u, v, s) <= R)) hits++;
        }
      }
      const a = hits / (SS * SS);
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) px[i + c] = Math.round(BG[c] * (1 - a) + FG[c] * a);
      px[i + 3] = 255;
    }
  }
  return px;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const rgba = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ICO with PNG-encoded entries (supported by every current browser).
function ico(sizes) {
  const images = sizes.map(png);
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((s, i) => {
    const e = 6 + 16 * i;
    header[e] = s >= 256 ? 0 : s;
    header[e + 1] = s >= 256 ? 0 : s;
    header.writeUInt16LE(1, e + 4); // planes
    header.writeUInt16LE(32, e + 6); // bpp
    header.writeUInt32LE(images[i].length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += images[i].length;
  });
  return Buffer.concat([header, ...images]);
}

const out = path.join(__dirname, '..', 'public');
fs.writeFileSync(path.join(out, 'icon.png'), png(512));
fs.writeFileSync(path.join(out, 'apple-touch-icon.png'), png(180));
fs.writeFileSync(path.join(out, 'favicon-32.png'), png(32));
fs.writeFileSync(path.join(out, 'favicon.ico'), ico([16, 32, 48]));
console.log('icons written to public/');

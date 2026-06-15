'use strict';
// Regenerates assets/stock-logo-ipodvideo.bin from the Rockbox source BMP.
// The blob is the search needle used to locate the logo in rockbox.ipod and
// the source for "restore original". Run: node build/generate-stock-logo.js
const fs = require('fs');
const path = require('path');
const { packRgb565LE, LOGO_WIDTH, LOGO_HEIGHT } = require('../lib/logo');

// Minimal 24-bit BMP -> top-to-bottom RGBA decoder (build/test use only).
function decodeBmp24ToRgba(buf) {
  const pixOff = buf.readUInt32LE(10);
  const width = buf.readInt32LE(18);
  const height = buf.readInt32LE(22);
  const depth = buf.readUInt16LE(28);
  if (depth !== 24) throw new Error(`expected a 24-bit BMP, got ${depth}-bit`);
  const H = Math.abs(height);
  const bottomUp = height > 0;
  const rowBytes = ((width * depth + 31) >> 5) << 2; // 4-byte aligned rows
  const rgba = Buffer.alloc(width * H * 4);
  for (let y = 0; y < H; y++) {
    const sy = bottomUp ? (H - 1 - y) : y;
    for (let x = 0; x < width; x++) {
      const p = pixOff + sy * rowBytes + x * 3;
      const b = buf[p], g = buf[p + 1], r = buf[p + 2]; // BMP is BGR
      const o = (y * width + x) * 4;
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
    }
  }
  return { width, height: H, rgba };
}

function generate() {
  const srcBmp = path.join(__dirname, '..', 'rockbox-src', 'apps', 'bitmaps',
    'native', 'rockboxlogo.320x98x16.bmp');
  const { width, height, rgba } = decodeBmp24ToRgba(fs.readFileSync(srcBmp));
  if (width !== LOGO_WIDTH || height !== LOGO_HEIGHT) {
    throw new Error(`source logo is ${width}x${height}, expected ${LOGO_WIDTH}x${LOGO_HEIGHT}`);
  }
  const blob = packRgb565LE(rgba);
  const outPath = path.join(__dirname, '..', 'assets', 'stock-logo-ipodvideo.bin');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, blob);
  return { outPath, blob };
}

module.exports = { decodeBmp24ToRgba, generate };

if (require.main === module) {
  const { outPath, blob } = generate();
  console.log(`Wrote ${outPath} (${blob.length} bytes)`);
}

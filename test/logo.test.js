// Validates the boot-logo helpers against the known iPod Video logo format:
// 320x98, RGB565 little-endian (no byte-swap), row-major, no padding = 62720 bytes.
//
// Run: node test/logo.test.js

const assert = require('assert');
const {
  LOGO_WIDTH, LOGO_HEIGHT, LOGO_BYTES, RGBA_BYTES,
  packRgb565LE,
} = require('../lib/logo');

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

// ---- constants ----
{
  assert.strictEqual(LOGO_WIDTH, 320);
  assert.strictEqual(LOGO_HEIGHT, 98);
  assert.strictEqual(LOGO_BYTES, 62720);
  assert.strictEqual(RGBA_BYTES, 125440);
  ok('exports the iPod Video logo dimensions');
}

// ---- packRgb565LE: solid colors encode correctly, little-endian ----
{
  const red = Buffer.alloc(RGBA_BYTES);
  for (let i = 0; i < RGBA_BYTES; i += 4) { red[i] = 255; red[i + 3] = 255; }
  const out = packRgb565LE(red);
  assert.strictEqual(out.length, LOGO_BYTES);
  // pure red -> 0xF800 -> little-endian bytes 0x00, 0xF8
  assert.strictEqual(out[0], 0x00);
  assert.strictEqual(out[1], 0xF8);
  assert.strictEqual(out.readUInt16LE(0), 0xF800);
  ok('packs pure red as 0xF800 little-endian');
}
{
  const white = Buffer.alloc(RGBA_BYTES, 0xFF);
  const out = packRgb565LE(white);
  assert.strictEqual(out.readUInt16LE(0), 0xFFFF);
  assert.strictEqual(out.readUInt16LE(LOGO_BYTES - 2), 0xFFFF);
  ok('packs pure white as 0xFFFF');
}
{
  // r=8,g=4,b=8 -> r>>3=1, g>>2=1, b>>3=1 -> (1<<11)|(1<<5)|1 = 0x0821
  const px = Buffer.alloc(RGBA_BYTES);
  for (let i = 0; i < RGBA_BYTES; i += 4) { px[i] = 8; px[i + 1] = 4; px[i + 2] = 8; px[i + 3] = 255; }
  assert.strictEqual(packRgb565LE(px).readUInt16LE(0), 0x0821);
  ok('packs a mixed color with correct 5-6-5 bit packing');
}
{
  assert.throws(() => packRgb565LE(Buffer.alloc(100)), /expected 125440 bytes/);
  ok('rejects RGBA of the wrong length');
}

const { findStockLogo, replaceLogo } = require('../lib/logo');

// ---- findStockLogo: single match, absent, duplicate ----
{
  const needle = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF]);
  const fw = Buffer.concat([Buffer.alloc(50), needle, Buffer.alloc(50)]);
  assert.strictEqual(findStockLogo(fw, needle), 50);
  ok('findStockLogo returns the single offset');
}
{
  const needle = Buffer.from([1, 2, 3, 4]);
  const fw = Buffer.alloc(200); // all zeros, needle absent
  assert.strictEqual(findStockLogo(fw, needle), -1);
  ok('findStockLogo returns -1 when absent');
}
{
  const needle = Buffer.from([7, 7]);
  const fw = Buffer.concat([needle, Buffer.alloc(10), needle]);
  assert.throws(() => findStockLogo(fw, needle), /more than once/);
  ok('findStockLogo throws on a duplicate match');
}

// ---- replaceLogo: in-place overwrite, length preserved, bounds checked ----
{
  const fw = Buffer.alloc(70000, 0x00);
  const blob = Buffer.alloc(LOGO_BYTES, 0xAB);
  const out = replaceLogo(fw, 100, blob);
  assert.strictEqual(out.length, fw.length);           // same size
  assert.strictEqual(out[99], 0x00);                   // byte before untouched
  assert.strictEqual(out[100], 0xAB);                  // blob start
  assert.strictEqual(out[100 + LOGO_BYTES - 1], 0xAB); // blob end
  assert.strictEqual(out[100 + LOGO_BYTES], 0x00);     // byte after untouched
  assert.strictEqual(fw[100], 0x00);                   // original not mutated
  ok('replaceLogo overwrites in place and preserves length');
}
{
  assert.throws(() => replaceLogo(Buffer.alloc(70000), 100, Buffer.alloc(10)), /must be 62720 bytes/);
  ok('replaceLogo rejects a wrong-length blob');
}
{
  const blob = Buffer.alloc(LOGO_BYTES, 1);
  assert.throws(() => replaceLogo(Buffer.alloc(LOGO_BYTES + 10), 20, blob), /out of bounds/);
  ok('replaceLogo rejects an out-of-bounds offset');
}

console.log(`\n${passed} assertions passed.`);

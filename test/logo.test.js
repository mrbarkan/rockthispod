// Validates the boot-logo helpers against the known iPod Video logo format:
// 320x98, RGB565 little-endian (no byte-swap), row-major, no padding = 62720 bytes.
//
// Run: node test/logo.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decodeBmp24ToRgba } = require('../build/generate-stock-logo');
const {
  LOGO_WIDTH, LOGO_HEIGHT, LOGO_PIXELS, LOGO_BYTES, RGBA_BYTES,
  packRgb565LE,
} = require('../lib/logo');

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

// ---- constants ----
{
  assert.strictEqual(LOGO_WIDTH, 320);
  assert.strictEqual(LOGO_HEIGHT, 98);
  assert.strictEqual(LOGO_PIXELS, 31360);
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

const { findStockLogo, replaceLogo, resolveTargetOffset } = require('../lib/logo');

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

// ---- resolveTargetOffset: stock present -> stock source ----
{
  const stock = Buffer.alloc(LOGO_BYTES, 0x5A);
  const fw = Buffer.concat([Buffer.alloc(200), stock, Buffer.alloc(200)]);
  const r = resolveTargetOffset(fw, stock, null);
  assert.strictEqual(r.offset, 200);
  assert.strictEqual(r.source, 'stock');
  assert.ok(r.original.equals(stock));
  ok('resolveTargetOffset uses the stock blob when present');
}
// ---- stock absent + valid sidecar -> sidecar source ----
{
  const stock = Buffer.alloc(LOGO_BYTES, 0x5A);     // not present in fw
  const fw = Buffer.alloc(63000, 0x00);
  const original = Buffer.alloc(LOGO_BYTES, 0x11);
  const sidecar = { offset: 100, firmwareBytes: 63000, originalBlobBase64: original.toString('base64') };
  const r = resolveTargetOffset(fw, stock, sidecar);
  assert.strictEqual(r.offset, 100);
  assert.strictEqual(r.source, 'sidecar');
  assert.ok(r.original.equals(original));
  ok('resolveTargetOffset falls back to a valid sidecar');
}
// ---- stock absent + no/invalid sidecar -> throws ----
{
  const stock = Buffer.alloc(LOGO_BYTES, 0x5A);
  const fw = Buffer.alloc(63000, 0x00);
  assert.throws(() => resolveTargetOffset(fw, stock, null), /could not locate/i);
  ok('resolveTargetOffset throws when neither stock nor sidecar resolves');
}
// ---- sidecar offset out of bounds is ignored -> throws ----
{
  const stock = Buffer.alloc(LOGO_BYTES, 0x5A);
  const fw = Buffer.alloc(63000, 0x00);
  const bad = { offset: 60000, firmwareBytes: 63000, originalBlobBase64: '' }; // 60000+62720 > 63000
  assert.throws(() => resolveTargetOffset(fw, stock, bad), /could not locate/i);
  ok('resolveTargetOffset ignores an out-of-bounds sidecar offset');
}
// ---- valid sidecar offset but corrupt/short saved original -> throws ----
{
  const stock = Buffer.alloc(LOGO_BYTES, 0x5A);
  const fw = Buffer.alloc(63000, 0x00);
  const corrupt = { offset: 100, firmwareBytes: 63000, originalBlobBase64: 'AAAA' }; // decodes to 3 bytes
  assert.throws(() => resolveTargetOffset(fw, stock, corrupt), /could not locate/i);
  ok('resolveTargetOffset rejects a sidecar with a wrong-length saved original');
}

const {
  isIpodVideoFirmware, ipodChecksum, fixIpodChecksum, applyLogoPatch,
  IPOD_VIDEO_MODEL_NUMBER, IPOD_HEADER_BYTES,
} = require('../lib/logo');

// Build a minimal but format-valid .ipod image: 8-byte header (BE checksum +
// "ipvd") followed by the body, with `logoBytes` placed at firmware-absolute
// offset `fwOffset` (>= header size) and a correct header checksum. Mirrors the
// real rockbox.ipod structure.
function makeFakeFirmware(logoBytes, fwOffset) {
  const fw = Buffer.alloc(fwOffset + LOGO_BYTES + 64, 0xA5);
  fw.write('ipvd', 4, 'latin1');
  logoBytes.copy(fw, fwOffset);
  return fixIpodChecksum(fw); // valid checksum to start, like a real image
}

// ---- isIpodVideoFirmware ----
{
  const fw = makeFakeFirmware(Buffer.alloc(LOGO_BYTES, 1), 100);
  assert.strictEqual(isIpodVideoFirmware(fw), true);
  const notIpod = Buffer.from(fw); notIpod.write('xxxx', 4, 'latin1');
  assert.strictEqual(isIpodVideoFirmware(notIpod), false);
  ok('isIpodVideoFirmware detects the "ipvd" model header');
}

// ---- ipodChecksum / fixIpodChecksum: MODEL_NUMBER + sum(body), big-endian ----
{
  const fw = makeFakeFirmware(Buffer.alloc(LOGO_BYTES, 0), 8);
  // header was set by fixIpodChecksum -> must already equal ipodChecksum
  assert.strictEqual(fw.readUInt32BE(0), ipodChecksum(fw));
  // manual cross-check of the algorithm
  let sum = IPOD_VIDEO_MODEL_NUMBER >>> 0;
  for (let i = IPOD_HEADER_BYTES; i < fw.length; i++) sum = (sum + fw[i]) >>> 0;
  assert.strictEqual(fw.readUInt32BE(0), sum >>> 0);
  ok('ipodChecksum = (MODEL_NUMBER + sum of body bytes), stored big-endian');
}
{
  const fw = makeFakeFirmware(Buffer.alloc(LOGO_BYTES, 0), 8);
  const tampered = Buffer.from(fw);
  tampered[IPOD_HEADER_BYTES + 5] ^= 0xFF; // change a body byte, leave header stale
  assert.notStrictEqual(tampered.readUInt32BE(0), ipodChecksum(tampered)); // now invalid
  const fixed = fixIpodChecksum(tampered);
  assert.strictEqual(fixed.readUInt32BE(0), ipodChecksum(fixed));          // valid again
  assert.ok(fixIpodChecksum(fixed).equals(fixed));                         // idempotent
  ok('fixIpodChecksum repairs a stale header and is idempotent');
}

// ---- applyLogoPatch: REGRESSION for "Bad checksum" — patched image must be VALID ----
{
  const stock = Buffer.alloc(LOGO_BYTES, 0x10);
  const offset = 256;
  const fw = makeFakeFirmware(stock, offset);
  assert.strictEqual(fw.readUInt32BE(0), ipodChecksum(fw)); // valid before

  const newLogo = Buffer.alloc(LOGO_BYTES, 0x7E);
  const patched = applyLogoPatch(fw, offset, newLogo);

  assert.strictEqual(patched.length, fw.length, 'size unchanged');
  assert.ok(patched.subarray(offset, offset + LOGO_BYTES).equals(newLogo), 'new logo written');
  // The bug this guards against: header checksum must match the new body.
  assert.strictEqual(patched.readUInt32BE(0), ipodChecksum(patched),
    'patched firmware passes the bootloader checksum');
  ok('applyLogoPatch writes the logo AND keeps the firmware checksum valid');
}
{
  // restore path: patch original back -> identical to the untouched image
  const stock = Buffer.alloc(LOGO_BYTES, 0x10);
  const offset = 256;
  const fw = makeFakeFirmware(stock, offset);
  const swapped = applyLogoPatch(fw, offset, Buffer.alloc(LOGO_BYTES, 0x7E));
  const restored = applyLogoPatch(swapped, offset, stock);
  assert.ok(restored.equals(fw), 'restore reproduces the original image byte-for-byte');
  ok('applyLogoPatch round-trips: swap then restore equals the original');
}

// ---- golden: shipped asset matches the validated logo exactly ----
{
  const blob = fs.readFileSync(path.join(__dirname, '..', 'assets', 'stock-logo-ipodvideo.bin'));
  assert.strictEqual(blob.length, LOGO_BYTES);
  const sha = crypto.createHash('sha256').update(blob).digest('hex');
  assert.strictEqual(sha, '1357a50d0da58a5fbd83c66126b22d65b2c8677b8dbc54a74b81c817d778afa9');
  ok('shipped stock-logo asset matches the validated sha256');
}
// ---- the asset is reproducible from source via the runtime packer ----
// rockbox-src/ is git-ignored (tracked only via patches/), so it is absent on a
// fresh clone / CI. Run this check only when the source BMP is present; the
// sha256 check above is the always-on guard.
{
  const srcBmp = path.join(__dirname, '..', 'rockbox-src', 'apps', 'bitmaps',
    'native', 'rockboxlogo.320x98x16.bmp');
  if (fs.existsSync(srcBmp)) {
    const { rgba } = decodeBmp24ToRgba(fs.readFileSync(srcBmp));
    const regenerated = packRgb565LE(rgba);
    const shipped = fs.readFileSync(path.join(__dirname, '..', 'assets', 'stock-logo-ipodvideo.bin'));
    assert.ok(regenerated.equals(shipped));
    ok('packer reproduces the shipped asset from the source BMP');
  } else {
    console.log('  skip - source BMP absent (rockbox-src not checked out)');
  }
}

console.log(`\n${passed} assertions passed.`);

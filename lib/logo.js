'use strict';

// The iPod Video boot logo (apps/bitmaps/native/rockboxlogo.320x98x16.bmp) is
// embedded uncompressed in rockbox.ipod as RGB565, little-endian, no byte-swap,
// row-major top-to-bottom, no row padding.
const LOGO_WIDTH = 320;
const LOGO_HEIGHT = 98;
const LOGO_PIXELS = LOGO_WIDTH * LOGO_HEIGHT;   // 31360
const LOGO_BYTES = LOGO_PIXELS * 2;             // 62720
const RGBA_BYTES = LOGO_PIXELS * 4;             // 125440

// Convert a 320x98 RGBA buffer (row-major, top-to-bottom, as produced by
// Canvas getImageData) into the native logo blob. Alpha is ignored.
function packRgb565LE(rgba) {
  if (rgba.length !== RGBA_BYTES) {
    throw new Error(`packRgb565LE: expected ${RGBA_BYTES} bytes of RGBA, got ${rgba.length}`);
  }
  const out = Buffer.allocUnsafe(LOGO_BYTES);
  for (let i = 0, o = 0; i < RGBA_BYTES; i += 4, o += 2) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const v = ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    out[o] = v & 0xff;
    out[o + 1] = (v >> 8) & 0xff;
  }
  return out;
}

// Find the single occurrence of `stockBlob` in `firmware`. Returns the byte
// offset, or -1 if absent. Throws if it occurs more than once (ambiguous —
// refuse to patch rather than guess).
function findStockLogo(firmware, stockBlob) {
  const first = firmware.indexOf(stockBlob);
  if (first === -1) return -1;
  const second = firmware.indexOf(stockBlob, first + 1);
  if (second !== -1) {
    throw new Error('findStockLogo: stock logo found more than once; refusing to patch');
  }
  return first;
}

// Return a copy of `firmware` with `blob` written at `offset`. Same length in,
// same length out — the firmware layout is never disturbed.
function replaceLogo(firmware, offset, blob) {
  if (blob.length !== LOGO_BYTES) {
    throw new Error(`replaceLogo: blob must be ${LOGO_BYTES} bytes, got ${blob.length}`);
  }
  if (offset < 0 || offset + blob.length > firmware.length) {
    throw new Error('replaceLogo: offset out of bounds');
  }
  const out = Buffer.from(firmware);
  blob.copy(out, offset);
  return out;
}

// Decide where to write the new logo and recover the true-original bytes.
// Strategy: if the stock blob is present (fresh install or post-reinstall),
// use that offset. Otherwise the device was already customized, so trust the
// persisted sidecar offset (validated against the current firmware length and
// bounds). Returns { offset, source: 'stock'|'sidecar', original: Buffer }.
function resolveTargetOffset(firmware, stockBlob, sidecar) {
  const stockOffset = findStockLogo(firmware, stockBlob); // throws on duplicate
  if (stockOffset !== -1) {
    return { offset: stockOffset, source: 'stock', original: Buffer.from(stockBlob) };
  }
  if (sidecar &&
      Number.isInteger(sidecar.offset) &&
      sidecar.firmwareBytes === firmware.length &&
      sidecar.offset >= 0 &&
      sidecar.offset + LOGO_BYTES <= firmware.length) {
    // A corrupt/truncated saved original is treated as no valid sidecar, so the
    // caller gets the clear "could not locate" error instead of a confusing
    // length mismatch later from replaceLogo.
    const original = Buffer.from(sidecar.originalBlobBase64 || '', 'base64');
    if (original.length === LOGO_BYTES) {
      return { offset: sidecar.offset, source: 'sidecar', original };
    }
  }
  throw new Error('Could not locate the boot logo: the stock logo was not found and there is no valid saved offset. This Rockbox build may be unsupported.');
}

module.exports = {
  LOGO_WIDTH, LOGO_HEIGHT, LOGO_PIXELS, LOGO_BYTES, RGBA_BYTES,
  packRgb565LE, findStockLogo, replaceLogo, resolveTargetOffset,
};

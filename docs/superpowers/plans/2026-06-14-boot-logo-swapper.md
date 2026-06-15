# Boot Logo Swapper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone "Change Boot Logo" tool to MacRockPod that swaps the Rockbox boot logo on an already-installed iPod Video by patching the 320×98 RGB565 bitmap embedded in `.rockbox/rockbox.ipod`.

**Architecture:** A renderer-side `<canvas>` decodes/fits/previews any user image and produces raw 320×98 RGBA. The main process packs that RGBA into the iPod-native RGB565-little-endian format (62,720 bytes), locates the stock logo blob in the firmware (shipped as `assets/stock-logo-ipodvideo.bin`), and overwrites it in place via an atomic temp-file rename. All non-UI logic lives in a pure, unit-tested `lib/logo.js`, mirroring the existing `lib/geometry.js` pattern. No new runtime dependencies (no `sips`, no npm image lib, no native modules) — important for the notarized build. The validated installer flow is not modified; it is gated behind a new home screen.

**Tech Stack:** Electron (CommonJS main + preload + renderer), pure Node `Buffer` logic, HTML5 Canvas 2D, `node`+`assert` tests (same harness as `test/geometry.test.js`).

**Validated facts (verified against the live daily build before planning):** the iPod Video boot logo is `rockboxlogo.320x98x16.bmp`, stored uncompressed in `rockbox.ipod` as RGB565 little-endian (no byte-swap), row-major top-to-bottom, no padding; the blob is **62,720 bytes**, appears **exactly once**, sha256 `1357a50d0da58a5fbd83c66126b22d65b2c8677b8dbc54a74b81c817d778afa9`; a pure-JS packer using `((r>>3)<<11)|((g>>2)<<5)|(b>>3)` reproduces the firmware bytes exactly.

---

## File Structure

- **Create `lib/logo.js`** — pure logic: `packRgb565LE`, `findStockLogo`, `replaceLogo`, `resolveTargetOffset`, plus dimension constants. No I/O, no Electron. Unit-tested.
- **Create `test/logo.test.js`** — `node`+`assert` tests, same style as `test/geometry.test.js`.
- **Create `build/generate-stock-logo.js`** — build-time tool that decodes the source BMP and writes `assets/stock-logo-ipodvideo.bin`. Exports its BMP decoder for the golden test.
- **Create `assets/stock-logo-ipodvideo.bin`** — the 62,720-byte stock logo blob (search needle + restore source). Committed.
- **Modify `main.js`** — refactor the device scan into a reusable helper; add `scan-rockbox-ipods`, `change-logo`, `restore-logo` IPC handlers + sidecar I/O helpers.
- **Modify `preload.js`** — expose the new IPC methods.
- **Modify `index.html`** — add a home screen and the logo-flow panels.
- **Modify `style.css`** — styles for the home screen, fit controls, and preview canvas; hide the install sidebar outside the install flow.
- **Modify `renderer.js`** — route from the home screen into either the existing install flow or the new logo flow; implement the canvas fit/preview/apply logic.
- **Modify `package.json`** — run both test files under `npm test`.
- **Modify `README.md`** — document the feature.

---

## Task 1: `lib/logo.js` — `packRgb565LE` + constants

**Files:**
- Create: `lib/logo.js`
- Test: `test/logo.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/logo.test.js`:

```js
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

console.log(`\n${passed} assertions passed.`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/logo.test.js`
Expected: FAIL — `Cannot find module '../lib/logo'`.

- [ ] **Step 3: Write minimal implementation**

Create `lib/logo.js`:

```js
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

module.exports = {
  LOGO_WIDTH, LOGO_HEIGHT, LOGO_PIXELS, LOGO_BYTES, RGBA_BYTES,
  packRgb565LE,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/logo.test.js`
Expected: PASS — 5 assertions passed.

- [ ] **Step 5: Commit**

```bash
git add lib/logo.js test/logo.test.js
git commit -m "feat(logo): add RGB565-LE packer with constants and tests"
```

---

## Task 2: `lib/logo.js` — `findStockLogo`

**Files:**
- Modify: `lib/logo.js`
- Test: `test/logo.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/logo.test.js` before the final `console.log`:

```js
const { findStockLogo } = require('../lib/logo');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/logo.test.js`
Expected: FAIL — `findStockLogo is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/logo.js` (and add `findStockLogo` to `module.exports`):

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/logo.test.js`
Expected: PASS — 8 assertions passed.

- [ ] **Step 5: Commit**

```bash
git add lib/logo.js test/logo.test.js
git commit -m "feat(logo): locate the stock logo blob in firmware"
```

---

## Task 3: `lib/logo.js` — `replaceLogo`

**Files:**
- Modify: `lib/logo.js`
- Test: `test/logo.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/logo.test.js`:

```js
const { replaceLogo } = require('../lib/logo');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/logo.test.js`
Expected: FAIL — `replaceLogo is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/logo.js` (and to `module.exports`):

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/logo.test.js`
Expected: PASS — 11 assertions passed.

- [ ] **Step 5: Commit**

```bash
git add lib/logo.js test/logo.test.js
git commit -m "feat(logo): replace logo bytes with bounds/length guards"
```

---

## Task 4: `lib/logo.js` — `resolveTargetOffset`

This decides where to write: re-locate the stock blob when present (first swap or after a reinstall), otherwise fall back to the persisted sidecar offset (the device was already customized, so the stock needle is gone).

**Files:**
- Modify: `lib/logo.js`
- Test: `test/logo.test.js`

- [ ] **Step 1: Write the failing test**

Add to `test/logo.test.js`:

```js
const { resolveTargetOffset } = require('../lib/logo');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/logo.test.js`
Expected: FAIL — `resolveTargetOffset is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `lib/logo.js` (and to `module.exports`):

```js
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
    return {
      offset: sidecar.offset,
      source: 'sidecar',
      original: Buffer.from(sidecar.originalBlobBase64 || '', 'base64'),
    };
  }
  throw new Error('Could not locate the boot logo: the stock logo was not found and there is no valid saved offset. This Rockbox build may be unsupported.');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/logo.test.js`
Expected: PASS — 15 assertions passed.

- [ ] **Step 5: Commit**

```bash
git add lib/logo.js test/logo.test.js
git commit -m "feat(logo): resolve patch offset from stock blob or sidecar"
```

---

## Task 5: Generate `assets/stock-logo-ipodvideo.bin` + golden test + wire `npm test`

**Files:**
- Create: `build/generate-stock-logo.js`
- Create: `assets/stock-logo-ipodvideo.bin` (generated, committed)
- Modify: `test/logo.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the build/generator script**

Create `build/generate-stock-logo.js`:

```js
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
```

- [ ] **Step 2: Generate the asset and verify its hash**

Run:
```bash
node build/generate-stock-logo.js
shasum -a 256 assets/stock-logo-ipodvideo.bin
wc -c < assets/stock-logo-ipodvideo.bin
```
Expected:
- `Wrote .../assets/stock-logo-ipodvideo.bin (62720 bytes)`
- sha256 = `1357a50d0da58a5fbd83c66126b22d65b2c8677b8dbc54a74b81c817d778afa9`
- size = `62720`

If the hash differs, STOP — the source BMP or packer has drifted from the validated format; do not commit a mismatched asset.

- [ ] **Step 3: Write the golden test**

Add to `test/logo.test.js` (top, with the other requires):

```js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { decodeBmp24ToRgba } = require('../build/generate-stock-logo');
```

Add before the final `console.log`:

```js
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
```

- [ ] **Step 4: Wire `npm test` to run both suites**

In `package.json`, change the `test` script:

```json
"test": "node test/geometry.test.js && node test/logo.test.js",
```

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: geometry assertions pass, then `17 assertions passed.` from the logo suite.

- [ ] **Step 6: Commit**

```bash
git add build/generate-stock-logo.js assets/stock-logo-ipodvideo.bin test/logo.test.js package.json
git commit -m "feat(logo): ship validated stock-logo asset with golden test"
```

---

## Task 6: `main.js` — refactor scan + `scan-rockbox-ipods` handler

**Files:**
- Modify: `main.js` (the `scan-ipods` handler, around lines 78-117; add new handler after it)

- [ ] **Step 1: Refactor the device-scan core into a reusable helper**

In `main.js`, replace the body of the `ipcMain.handle('scan-ipods', ...)` so the disk-discovery logic is a standalone async function both handlers can call. Replace lines 78-117 with:

```js
// Discover connected iPod disks (shared by the installer and the logo tool).
async function discoverIpods() {
  const listRes = await runCommand('diskutil list');
  if (!listRes.success) return [];

  const disks = [];
  const regex = /\/dev\/(disk\d+)\s+\(external,\s+physical\):/g;
  let match;
  while ((match = regex.exec(listRes.stdout)) !== null) {
    disks.push(match[1]);
  }

  const ipods = [];
  for (const disk of disks) {
    const infoRes = await runCommand(`diskutil info ${disk}`);
    if (!infoRes.success) continue;
    const info = infoRes.stdout;

    const mediaType = (/Media Type:\s+(.+)/.exec(info) || [])[1]?.trim() || '';
    const mediaName = (/Device \/ Media Name:\s+(.+)/.exec(info) || [])[1]?.trim() || '';
    const size = (/Disk Size:\s+(.+)/.exec(info) || [])[1]?.trim() || 'Unknown';
    const content = (/Content \(IOContent\):\s+(.+)/.exec(info) || [])[1]?.trim() || '';

    const isIpod = mediaType.toLowerCase().includes('ipod') ||
                   mediaName.toLowerCase().includes('ipod') ||
                   content.toLowerCase().includes('apple_mdfw');
    if (!isIpod) continue;

    const isMacPod = content.includes('Apple_partition_scheme');

    ipods.push({
      id: disk,
      name: mediaName || 'iPod',
      size: size.split('(')[0].trim(),
      type: isMacPod ? 'macpod' : 'winpod',
      volumeName: 'IPOD'
    });
  }
  return ipods;
}

// Find the mount point of a disk's data volume that contains a Rockbox install.
async function findRockboxMount(diskId) {
  for (const suffix of ['s2', 's1']) {
    const mc = await runCommand(`diskutil info ${diskId}${suffix}`);
    const mm = /Mount Point:\s+(\/.+)/.exec(mc.stdout || '');
    if (mm) {
      const mountPath = mm[1].trim();
      if (fs.existsSync(path.join(mountPath, '.rockbox', 'rockbox.ipod'))) {
        return mountPath;
      }
    }
  }
  return null;
}

ipcMain.handle('scan-ipods', async () => discoverIpods());

// Like scan-ipods, but only iPods that already have Rockbox installed, with the
// mount path of the volume holding .rockbox/rockbox.ipod.
ipcMain.handle('scan-rockbox-ipods', async () => {
  const ipods = await discoverIpods();
  const result = [];
  for (const ip of ipods) {
    const mountPath = await findRockboxMount(ip.id);
    if (mountPath) result.push({ ...ip, mountPath });
  }
  return result;
});
```

- [ ] **Step 2: Verify the app still scans (no regression)**

Run: `npm start`
Expected: the app launches and the installer's device scan still works exactly as before (the `scan-ipods` behavior is unchanged). Quit the app.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "refactor(main): share iPod discovery; add scan-rockbox-ipods"
```

---

## Task 7: `main.js` — sidecar helpers + `change-logo` / `restore-logo`

**Files:**
- Modify: `main.js` (add `require` for `lib/logo`; add helpers + handlers near the other `ipcMain.handle` blocks)

- [ ] **Step 1: Import the logo module**

At the top of `main.js`, update the geometry require line to also pull in the logo helpers:

```js
const { parseIpodpatcherList, buildWinpodMbr, computeLayout } = require('./lib/geometry');
const { packRgb565LE, resolveTargetOffset, replaceLogo, findStockLogo, LOGO_BYTES } = require('./lib/logo');
```

- [ ] **Step 2: Add sidecar helpers + the two handlers**

Add this block in `main.js` after the `scan-rockbox-ipods` handler:

```js
// ---------------------------------------------------------------------------
// Boot logo swap (standalone re-skin of an already-installed iPod)
// ---------------------------------------------------------------------------

function stockLogoBlob() {
  return fs.readFileSync(path.join(__dirname, 'assets', 'stock-logo-ipodvideo.bin'));
}
function firmwarePath(mountPath) { return path.join(mountPath, '.rockbox', 'rockbox.ipod'); }
function sidecarPath(mountPath) { return path.join(mountPath, '.rockbox', '.macrockpod-logo.json'); }

function readSidecar(mountPath) {
  try { return JSON.parse(fs.readFileSync(sidecarPath(mountPath), 'utf8')); }
  catch (_) { return null; }
}
function writeSidecar(mountPath, data) {
  fs.writeFileSync(sidecarPath(mountPath), JSON.stringify(data, null, 2));
}

// Write `patched` over the firmware atomically (temp file on the same volume,
// then rename) so a failure can never leave a half-written rockbox.ipod.
function writeFirmwareAtomic(mountPath, patched) {
  const fwPath = firmwarePath(mountPath);
  const tmp = fwPath + '.macrockpod.tmp';
  fs.writeFileSync(tmp, patched);
  fs.renameSync(tmp, fwPath);
}

ipcMain.handle('change-logo', async (_event, { mountPath, rgba }) => {
  try {
    const firmware = fs.readFileSync(firmwarePath(mountPath));
    const newBlob = packRgb565LE(Buffer.from(rgba)); // rgba arrives as an ArrayBuffer
    if (newBlob.length !== LOGO_BYTES) throw new Error('Internal: bad converted logo size.');

    const stock = stockLogoBlob();
    const existing = readSidecar(mountPath);
    const { offset, source, original } = resolveTargetOffset(firmware, stock, existing);

    // Persist the true-original bytes once so re-swaps and restore keep working.
    const sidecar = (existing && existing.offset === offset)
      ? existing
      : { offset, firmwareBytes: firmware.length, originalBlobBase64: original.toString('base64') };

    writeFirmwareAtomic(mountPath, replaceLogo(firmware, offset, newBlob));
    writeSidecar(mountPath, sidecar);
    return { success: true, offset, source };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('restore-logo', async (_event, { mountPath }) => {
  try {
    const firmware = fs.readFileSync(firmwarePath(mountPath));
    const sidecar = readSidecar(mountPath);
    if (sidecar &&
        Number.isInteger(sidecar.offset) &&
        sidecar.firmwareBytes === firmware.length &&
        sidecar.offset + LOGO_BYTES <= firmware.length) {
      const original = Buffer.from(sidecar.originalBlobBase64 || '', 'base64');
      if (original.length !== LOGO_BYTES) throw new Error('Saved original logo is corrupt.');
      writeFirmwareAtomic(mountPath, replaceLogo(firmware, sidecar.offset, original));
      try { fs.unlinkSync(sidecarPath(mountPath)); } catch (_) {}
      return { success: true, restored: true };
    }
    // No sidecar: if the stock logo is already present, there is nothing to undo.
    if (findStockLogo(firmware, stockLogoBlob()) !== -1) {
      return { success: true, alreadyStock: true };
    }
    throw new Error('No saved original logo to restore on this iPod.');
  } catch (err) {
    return { success: false, error: err.message };
  }
});
```

- [ ] **Step 3: Smoke-test the handlers compile/load**

Run: `node -e "require('./main.js')" 2>&1 | head -5`
Expected: it fails only because Electron's `app` isn't running (e.g. an Electron/app error), NOT with a `SyntaxError` or `Cannot find module`. A syntax error here means fix before continuing. (You can also just run `npm start` and confirm the window still opens.)

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(main): change-logo and restore-logo IPC with atomic write + sidecar"
```

---

## Task 8: `preload.js` — expose logo IPC

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Add the new bridge methods**

In `preload.js`, add inside the `exposeInMainWorld('electronAPI', { ... })` object (after `openFdaSettings`):

```js
  scanRockboxIpods: () => ipcRenderer.invoke('scan-rockbox-ipods'),
  changeLogo: (mountPath, rgbaBuffer) => ipcRenderer.invoke('change-logo', { mountPath, rgba: rgbaBuffer }),
  restoreLogo: (mountPath) => ipcRenderer.invoke('restore-logo', { mountPath }),
```

- [ ] **Step 2: Verify preload loads**

Run: `npm start`
Expected: app window opens with no preload errors in the terminal. Quit the app.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(preload): expose scan-rockbox-ipods, change-logo, restore-logo"
```

---

## Task 9: `index.html` + `style.css` — home screen + logo panels

**Files:**
- Modify: `index.html` (add a home panel before `#panel-scan`; add logo panels after `#panel-finish`)
- Modify: `style.css` (sidebar visibility + logo-flow styles)

- [ ] **Step 1: Add the home screen panel**

In `index.html`, immediately after `<section class="main-content">` (before `<!-- Panel 1: Device Selection -->`), insert:

```html
      <!-- Panel 0: Home -->
      <div class="panel-screen active" id="panel-home">
        <h2>MacRockPod</h2>
        <p class="subtitle">What would you like to do?</p>
        <div class="home-choices">
          <button class="glass-card home-choice" id="choice-install">
            <span class="home-choice-title">Install Rockbox</span>
            <span class="home-choice-desc">Format a flash-modded iPod Video and install Rockbox.</span>
          </button>
          <button class="glass-card home-choice" id="choice-logo">
            <span class="home-choice-title">Change Boot Logo</span>
            <span class="home-choice-desc">Swap the boot logo on an iPod that already runs Rockbox.</span>
          </button>
        </div>
      </div>
```

Then change the existing `#panel-scan` opening tag from `class="panel-screen active"` to `class="panel-screen"` (the home panel is now the initial active screen).

- [ ] **Step 2: Add the logo-flow panels**

In `index.html`, after the closing `</div>` of `#panel-finish` (before `</section>`), insert:

```html
      <!-- Logo Panel A: Select Rockbox iPod -->
      <div class="panel-screen" id="panel-logo-select">
        <h2>Change Boot Logo</h2>
        <p class="subtitle">Select an iPod that already has Rockbox installed.</p>
        <div class="device-list" id="logo-device-list">
          <div class="loading-spinner-container" id="logo-scan-loading">
            <div class="spinner"></div>
            <p>Scanning for Rockbox iPods...</p>
          </div>
        </div>
        <div class="configuration-card glass-card">
          <p class="card-desc">Plug the iPod in with the <strong>HOLD switch ON</strong> so it mounts in disk mode. Only iPods with a Rockbox install (<code>.rockbox/rockbox.ipod</code>) are listed.</p>
        </div>
        <div class="actions-row">
          <button class="btn secondary-btn" id="btn-logo-back-home">Back</button>
          <button class="btn secondary-btn" id="btn-logo-rescan">Rescan</button>
          <button class="btn primary-btn disabled" id="btn-logo-to-config" disabled>Choose Image</button>
        </div>
      </div>

      <!-- Logo Panel B: Pick image, fit, preview -->
      <div class="panel-screen" id="panel-logo-config">
        <h2>Boot Logo</h2>
        <p class="subtitle">Pick an image, choose how it fits the 320×98 logo area, then apply.</p>

        <div class="glass-card logo-config-card">
          <input type="file" id="logo-file-input" accept="image/*" hidden>
          <button class="btn secondary-btn" id="btn-pick-image">Choose Image…</button>
          <span id="logo-file-name" class="logo-file-name">No image selected</span>

          <div class="logo-preview-wrap">
            <canvas id="logo-preview" width="320" height="98"></canvas>
          </div>

          <div class="logo-controls">
            <div class="logo-control-group">
              <span class="logo-control-label">Fit</span>
              <label><input type="radio" name="logo-fit" value="letterbox" checked> Letterbox</label>
              <label><input type="radio" name="logo-fit" value="crop"> Crop</label>
              <label><input type="radio" name="logo-fit" value="stretch"> Stretch</label>
            </div>
            <div class="logo-control-group">
              <span class="logo-control-label">Background</span>
              <input type="color" id="logo-pad-color" value="#000000">
            </div>
          </div>
        </div>

        <div class="actions-row">
          <button class="btn secondary-btn" id="btn-logo-back-select">Back</button>
          <button class="btn secondary-btn" id="btn-logo-restore">Restore Original</button>
          <button class="btn primary-btn disabled" id="btn-logo-apply" disabled>Apply Logo</button>
        </div>
        <p class="progress-status-text" id="logo-status-text"></p>
      </div>

      <!-- Logo Panel C: Done -->
      <div class="panel-screen" id="panel-logo-done">
        <div class="success-icon-container">
          <div class="success-circle">
            <svg class="checkmark-svg" viewBox="0 0 52 52">
              <circle class="checkmark-circle" cx="26" cy="26" r="25" fill="none"/>
              <path class="checkmark-check" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>
            </svg>
          </div>
        </div>
        <h2 id="logo-done-title">Boot Logo Updated!</h2>
        <p class="subtitle" id="logo-done-subtitle">Eject the iPod, then reset it (toggle HOLD off and hold MENU+SELECT for ~6 seconds) to see the new logo.</p>
        <div class="actions-row">
          <button class="btn secondary-btn" id="btn-logo-another">Change Another</button>
          <button class="btn primary-btn" id="btn-logo-home">Done</button>
        </div>
      </div>
```

- [ ] **Step 3: Add CSS for the home screen and logo flow**

Append to `style.css`:

```css
/* ---- Home screen & logo flow ---- */
.sidebar-progress { display: none; }
body.mode-install .sidebar-progress { display: flex; }

.home-choices { display: flex; flex-direction: column; gap: 16px; margin-top: 24px; }
.home-choice {
  display: flex; flex-direction: column; gap: 6px; text-align: left;
  padding: 20px; cursor: pointer; border: none; width: 100%;
  font-family: inherit; transition: transform 0.12s ease;
}
.home-choice:hover { transform: translateY(-2px); }
.home-choice-title { font-size: 17px; font-weight: 600; color: var(--text-color); }
.home-choice-desc { font-size: 13px; color: var(--text-muted); }

.logo-config-card { padding: 18px; display: flex; flex-direction: column; gap: 14px; align-items: flex-start; }
.logo-file-name { font-size: 12.5px; color: var(--text-muted); }
.logo-preview-wrap {
  width: 100%; display: flex; justify-content: center; padding: 16px;
  background: repeating-conic-gradient(#2a2a2a 0% 25%, #1f1f1f 0% 50%) 50% / 20px 20px;
  border-radius: 8px;
}
#logo-preview { width: 320px; height: 98px; image-rendering: pixelated; box-shadow: 0 0 0 1px rgba(255,255,255,0.1); }
.logo-controls { display: flex; gap: 28px; flex-wrap: wrap; }
.logo-control-group { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-color); }
.logo-control-group label { display: inline-flex; align-items: center; gap: 4px; }
.logo-control-label { font-weight: 600; color: var(--text-muted); }
```

(If `var(--text-color)` / `var(--text-muted)` / `var(--accent-color)` are not the exact variable names in `style.css`, match whatever the file already defines — check the top of `style.css`.)

- [ ] **Step 4: Verify the layout renders**

Run: `npm start`
Expected: the app opens on the new home screen with two choice cards and no sidebar. (The buttons do nothing yet — wired in Task 10.) Quit the app.

- [ ] **Step 5: Commit**

```bash
git add index.html style.css
git commit -m "feat(ui): home screen and boot-logo panels"
```

---

## Task 10: `renderer.js` — routing + logo flow (canvas)

**Files:**
- Modify: `renderer.js`

- [ ] **Step 1: Stop auto-running the installer scan on load**

In `renderer.js`, find these lines near the top of the `DOMContentLoaded` handler (around line 51):

```js
  checkRootStatus();
  scanDevices();
```

Replace them with:

```js
  // Start on the home screen; each flow scans when entered.
  document.body.classList.remove('mode-install');
```

- [ ] **Step 2: Add home-screen routing + the logo flow**

Append this block inside the `DOMContentLoaded` handler, just before its closing `});` (i.e., after `renderErrorHelp` is defined, at the end of the existing code):

```js
  // ---- Panel routing helpers ----
  function showPanel(id, mode) {
    document.querySelectorAll('.panel-screen').forEach((p) => p.classList.remove('active'));
    document.getElementById(id).classList.add('active');
    document.body.classList.toggle('mode-install', mode === 'install');
  }

  // ---- Home screen ----
  document.getElementById('choice-install').addEventListener('click', () => {
    showPanel('panel-scan', 'install');
    checkRootStatus();
    scanDevices();
  });
  document.getElementById('choice-logo').addEventListener('click', () => {
    showPanel('panel-logo-select', 'logo');
    scanRockboxDevices();
  });

  // ---- Logo flow state ----
  const logoDeviceList = document.getElementById('logo-device-list');
  const btnLogoToConfig = document.getElementById('btn-logo-to-config');
  const fileInput = document.getElementById('logo-file-input');
  const previewCanvas = document.getElementById('logo-preview');
  const previewCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
  const logoStatus = document.getElementById('logo-status-text');
  const btnApply = document.getElementById('btn-logo-apply');

  let logoDevice = null;   // { ...ipod, mountPath }
  let logoImage = null;    // ImageBitmap

  async function scanRockboxDevices() {
    logoDevice = null;
    btnLogoToConfig.classList.add('disabled');
    btnLogoToConfig.disabled = true;
    logoDeviceList.innerHTML = `
      <div class="loading-spinner-container"><div class="spinner"></div>
      <p>Scanning for Rockbox iPods...</p></div>`;
    let devices = [];
    try { devices = await window.electronAPI.scanRockboxIpods(); } catch (_) {}
    logoDeviceList.innerHTML = '';
    if (!devices.length) {
      logoDeviceList.innerHTML = `
        <div class="loading-spinner-container">
        <p style="color: var(--text-muted);">No Rockbox iPod found. Plug it in with HOLD ON, then Rescan.</p></div>`;
      return;
    }
    devices.forEach((dev) => {
      const card = document.createElement('div');
      card.className = 'device-card';
      card.innerHTML = `
        <div class="device-info">
          <div class="device-title">${dev.name}</div>
          <div class="device-details">${dev.size} • ${dev.id}</div>
        </div>
        <span class="device-badge winpod">Rockbox</span>`;
      card.addEventListener('click', () => {
        document.querySelectorAll('#logo-device-list .device-card').forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        logoDevice = dev;
        btnLogoToConfig.classList.remove('disabled');
        btnLogoToConfig.disabled = false;
      });
      logoDeviceList.appendChild(card);
    });
  }

  document.getElementById('btn-logo-rescan').addEventListener('click', scanRockboxDevices);
  document.getElementById('btn-logo-back-home').addEventListener('click', () => showPanel('panel-home', 'home'));
  document.getElementById('btn-logo-to-config').addEventListener('click', () => {
    showPanel('panel-logo-config', 'logo');
    logoStatus.textContent = '';
    redrawPreview();
  });
  document.getElementById('btn-logo-back-select').addEventListener('click', () => showPanel('panel-logo-select', 'logo'));

  // ---- Image picking + canvas fit/preview ----
  document.getElementById('btn-pick-image').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    document.getElementById('logo-file-name').textContent = file.name;
    try {
      logoImage = await createImageBitmap(file);
    } catch (_) {
      logoStatus.textContent = 'Could not read that image. Try a PNG or JPG.';
      return;
    }
    redrawPreview();
    btnApply.classList.remove('disabled');
    btnApply.disabled = false;
  });

  function currentFit() {
    return document.querySelector('input[name="logo-fit"]:checked').value;
  }
  function currentPad() {
    return document.getElementById('logo-pad-color').value;
  }

  function redrawPreview() {
    const W = 320, H = 98;
    previewCtx.clearRect(0, 0, W, H);
    previewCtx.fillStyle = currentPad();
    previewCtx.fillRect(0, 0, W, H);
    if (!logoImage) return;
    const iw = logoImage.width, ih = logoImage.height;
    const fit = currentFit();
    if (fit === 'stretch') {
      previewCtx.drawImage(logoImage, 0, 0, W, H);
    } else {
      const s = fit === 'crop' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih);
      const dw = iw * s, dh = ih * s;
      previewCtx.drawImage(logoImage, (W - dw) / 2, (H - dh) / 2, dw, dh);
    }
  }

  document.querySelectorAll('input[name="logo-fit"]').forEach((r) => r.addEventListener('change', redrawPreview));
  document.getElementById('logo-pad-color').addEventListener('input', redrawPreview);

  // ---- Apply / restore ----
  document.getElementById('btn-logo-apply').addEventListener('click', async () => {
    if (!logoDevice || !logoImage) return;
    btnApply.disabled = true;
    logoStatus.textContent = 'Applying logo...';
    const rgba = previewCtx.getImageData(0, 0, 320, 98).data; // Uint8ClampedArray
    const res = await window.electronAPI.changeLogo(logoDevice.mountPath, rgba.buffer);
    btnApply.disabled = false;
    if (res && res.success) {
      showPanel('panel-logo-done', 'logo');
    } else {
      logoStatus.innerHTML = `❌ <span style="color:#e74c3c;">${(res && res.error) || 'Failed to apply logo.'}</span>`;
    }
  });

  document.getElementById('btn-logo-restore').addEventListener('click', async () => {
    if (!logoDevice) return;
    logoStatus.textContent = 'Restoring original logo...';
    const res = await window.electronAPI.restoreLogo(logoDevice.mountPath);
    if (res && res.success) {
      document.getElementById('logo-done-title').textContent = res.alreadyStock ? 'Already the Original Logo' : 'Original Logo Restored!';
      showPanel('panel-logo-done', 'logo');
    } else {
      logoStatus.innerHTML = `❌ <span style="color:#e74c3c;">${(res && res.error) || 'Failed to restore.'}</span>`;
    }
  });

  document.getElementById('btn-logo-another').addEventListener('click', () => {
    document.getElementById('logo-done-title').textContent = 'Boot Logo Updated!';
    showPanel('panel-logo-select', 'logo');
    scanRockboxDevices();
  });
  document.getElementById('btn-logo-home').addEventListener('click', () => {
    document.getElementById('logo-done-title').textContent = 'Boot Logo Updated!';
    showPanel('panel-home', 'home');
  });
```

- [ ] **Step 2: Verify the full flow in the app**

Run: `npm start`
Then exercise:
1. Home screen shows; click **Install Rockbox** → installer scan appears with the sidebar. Click the titlebar/Back paths and return home (reload the app if needed).
2. From home, click **Change Boot Logo** → Rockbox-iPod scan appears (no sidebar).
3. Click **Choose Image…**, pick a PNG/JPG → preview renders at 320×98; toggling Letterbox/Crop/Stretch and the background color updates the preview live.

Expected: all UI transitions work and the preview updates. (Applying to a real iPod is covered in Task 11.) Quit the app.

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(renderer): home routing + canvas-based logo fit/preview/apply"
```

---

## Task 11: README, packaging check, end-to-end verification

**Files:**
- Modify: `README.md`
- Verify: `package.json` packaging includes `assets/`

- [ ] **Step 1: Document the feature in `README.md`**

Add a section describing the Change Boot Logo tool: it swaps the 320×98 Rockbox boot logo on an already-installed iPod Video, accepts any image (letterbox/crop/stretch + background color), needs no admin password or Full Disk Access (it writes the user-mounted IPOD volume), writes a `.rockbox/.macrockpod-logo.json` sidecar to support re-swapping and "Restore Original", and that a device reset is needed to see the new logo. Note it only works on supported Rockbox builds (it locates the known stock logo) and fails safely otherwise. Match the README's existing tone/structure.

- [ ] **Step 2: Confirm the asset is bundled by the packager**

Run: `grep -n "ignore" package.json`
Confirm none of the `--ignore` patterns match `assets/` (current ignores: `rockbox-src`, `dist`, `build`, `test`, `repair-`, `\.md$`, `\.DS_Store$`). `assets/` is not ignored, so it ships. If you want to be certain, run `npm run package` and verify the file exists:

```bash
npm run package
ls dist/MacRockPod-darwin-arm64/MacRockPod.app/Contents/Resources/app/assets/stock-logo-ipodvideo.bin
```
Expected: the `.bin` is present in the packaged app.

- [ ] **Step 3: Full test suite green**

Run: `npm test`
Expected: all geometry assertions pass, then `17 assertions passed.`

- [ ] **Step 4: End-to-end on a real iPod (manual, requires hardware)**

With a Rockbox-installed iPod Video connected (HOLD on, mounted):
1. `npm start` → Change Boot Logo → select the iPod → choose an image → Apply.
2. Confirm success screen. Eject, reset the iPod (HOLD off, MENU+SELECT ~6s), and confirm the new logo shows on boot.
3. Reconnect → Change Boot Logo → select iPod → **Restore Original** → confirm; reset and confirm the stock logo returns.
4. Confirm `.rockbox/.macrockpod-logo.json` was created/removed appropriately and `rockbox.ipod` size is unchanged (`ls -l` before/after — same byte count).

Expected: logo changes on device; restore returns the stock logo; firmware size unchanged. (If no hardware is available, note that this step is deferred and rely on the unit tests + in-app preview.)

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: document the boot logo swapper feature"
```

---

## Self-Review Notes

- **Spec coverage:** §2 mechanism → Tasks 1-5 (packer/locator/replacer + validated asset). §3.1 renderer canvas → Tasks 9-10. §3.2 lib/logo.js → Tasks 1-4. §3.3 main handlers + no-elevation → Tasks 6-7. §3.4 shipped asset → Task 5. §4 safety (single-match, re-swap sidecar, restore, atomic write, length invariants) → Tasks 4, 7 (+ tests in 1-4). §5 UX (home screen, fit/pad/preview, reset note, restore) → Tasks 9-10. §6 testing → Tasks 1-5, 11. §8 files touched → all tasks.
- **Type consistency:** `lib/logo.js` exports `packRgb565LE`, `findStockLogo`, `replaceLogo`, `resolveTargetOffset`, `LOGO_BYTES`, `LOGO_WIDTH`, `LOGO_HEIGHT`, `RGBA_BYTES` — used with those exact names in `main.js` and the tests. `change-logo`/`restore-logo`/`scan-rockbox-ipods` channel names match between `main.js` and `preload.js`. `resolveTargetOffset` returns `{ offset, source, original }`, consumed exactly so in the `change-logo` handler.
- **RGBA transfer:** renderer sends `getImageData(...).data.buffer` (an `ArrayBuffer`); `main.js` wraps it with `Buffer.from(rgba)`. `packRgb565LE` validates the 125,440-byte length, so a malformed transfer fails loudly rather than silently corrupting the firmware.

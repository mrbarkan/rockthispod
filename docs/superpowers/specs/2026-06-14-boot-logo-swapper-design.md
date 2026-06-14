# Boot Logo Swapper — Design

**Date:** 2026-06-14
**Status:** Approved (design); implementation pending
**Scope:** Add a standalone "Change Boot Logo" feature to MacRockPod that replaces the
Rockbox boot logo on an already-installed iPod Video, equivalent to rockbox.org's LogoSwapper.

## 1. Goal

Let the user pick any image and have the app resize/fit/convert it and swap it into the
Rockbox firmware as the boot logo — the graphic shown when Rockbox starts up. This is a
**re-skin tool for an already-installed iPod**, independent of the install flow. The
validated installer recipe is **not modified**.

## 2. Validated mechanism

Every claim below was verified against the actual current daily build
(`https://build.rockbox.org/data/rockbox-ipodvideo.zip`, firmware version
`f07e977d7c-260613`) before this design was written.

- The boot logo a user sees comes from the **main firmware** `.rockbox/rockbox.ipod`, drawn
  by `apps/main.c:show_logo_boot()`. The iPod Video **bootloader** (`bootloader/ipod.c`) is
  text-only, so it is **not** involved.
- For the iPod Video (LCD width 320, depth ≥ 16) the logo bitmap is
  `apps/bitmaps/native/rockboxlogo.320x98x16.bmp` — **320 × 98 pixels**.
- It is embedded **uncompressed** in `rockbox.ipod` (which is a raw ARM binary behind an
  8-byte scramble header — model `ipvd`, then the body; ~21% zero bytes, long zero runs →
  definitively not a compressed blob).
- On-disk pixel format: **RGB565, little-endian, not byte-swapped**, row-major top-to-bottom,
  no row padding. That is `tools/bmp2rb` **format 4** packed little-endian. (Note: bmp2rb's
  help text labels format 5 "iPod"; the current iPod Video build actually uses the plain
  format-4 packing. Confirmed empirically.)
- Blob size: 320 × 98 × 2 = **62,720 bytes**. It appears **exactly once** in the firmware
  (verified `occurrences == 1`), at a build-stable offset (1088468 in the tested build).
- A pure-JS packer using `v = ((r>>3)<<11) | ((g>>2)<<5) | (b>>3)`, written as little-endian
  uint16, reproduces the firmware bytes **exactly** (full 62,720-byte match). No native
  module, no bundled `bmp2rb`, no `sips` needed at runtime.

**Implication:** locate-and-replace is reliable. We ship the known stock logo blob as the
search needle; finding it gives the offset to overwrite with the user's converted image.
Same length in, same length out, so firmware size and layout are untouched.

## 3. Architecture

Three pieces, mirroring the existing `lib/geometry.js` + `main.js` split so the hard logic
stays pure and unit-testable.

### 3.1 Renderer — decode, fit, preview (`renderer.js` + a `<canvas>`)

The renderer is a browser, so it does all image handling natively:

1. `<input type="file" accept="image/*">` → user picks any image (PNG/JPG/GIF/WebP/BMP/…).
2. `createImageBitmap(file)` decodes it.
3. Draw onto a **320 × 98** offscreen canvas using the selected **fit mode**:
   - **Letterbox** — scale to fit inside 320×98 preserving aspect; fill remainder with the
     pad color (`fillRect` first, then `drawImage` centered).
   - **Crop** — scale to cover 320×98 preserving aspect; overflow is clipped by the canvas.
   - **Stretch** — `drawImage` to exactly 320×98, ignoring aspect.
4. The same canvas, scaled up ~2×, **is the live preview** — changing fit mode or pad color
   re-renders it. WYSIWYG (full color; on-device is RGB565, very slightly banded).
5. On **Apply**: `ctx.getImageData(0,0,320,98).data` → raw RGBA (125,440 bytes) sent to main
   via IPC. No file path crosses IPC; the renderer never touches `fs`.

### 3.2 `lib/logo.js` — pure, unit-tested

- `packRgb565LE(rgba: Buffer|Uint8ClampedArray) -> Buffer` — 125,440-byte RGBA → 62,720-byte
  RGB565-LE blob. Throws if input length ≠ 320×98×4.
- `findStockLogo(firmware: Buffer, stockBlob: Buffer) -> number` — returns the single offset,
  or −1 if not found. Errors if found more than once.
- `replaceLogo(firmware: Buffer, offset: number, blob: Buffer) -> Buffer` — returns a copy with
  the 62,720 bytes overwritten; asserts blob length and bounds.

### 3.3 `main.js` — IPC handlers (new)

- `scan-rockbox-ipods` — like `scan-ipods`, but also locates each device's mounted volume and
  keeps only those with `.rockbox/rockbox.ipod` present (i.e. Rockbox already installed).
- `change-logo` — given `{ mountPath, rgba, /* for logging: fitMode, padColor */ }`:
  1. Read `<mountPath>/.rockbox/rockbox.ipod`.
  2. `packRgb565LE(rgba)` → new blob (validate 62,720 bytes).
  3. Determine the target offset (see §4 sidecar logic).
  4. Back up the original logo bytes + offset to the sidecar (first swap only).
  5. `replaceLogo` → write to a temp file on the same volume → `fs.renameSync` over the
     original (atomic; a crash can't leave a half-written firmware).
- `restore-logo` — re-patch the saved offset with the shipped stock blob (or the sidecar's
  saved original), then clear/update the sidecar.

**No elevation:** the IPOD FAT32 volume mounts user-writable, so this flow needs **no admin
password and no Full Disk Access** — unlike the installer. Handle read-only / busy-volume
errors gracefully.

### 3.4 Shipped asset

`assets/stock-logo-ipodvideo.bin` — the 62,720-byte stock logo blob, generated once at build
time from `rockbox-src/apps/bitmaps/native/rockboxlogo.320x98x16.bmp` via `bmp2rb -f 4`
(or equivalently the JS packer). Used as the search needle and as the "restore" source.
Added to the packaged app (the packager currently ignores `rockbox-src`, so the asset lives
under `assets/`, not referenced from the source tree at runtime).

## 4. Safety & robustness

- **Single-match requirement.** Apply only proceeds if the stock blob (or the sidecar offset)
  resolves to exactly one valid 62,720-byte target. Zero matches → "Couldn't find the stock
  Rockbox logo in this build (it may have been updated); logo swap isn't available for this
  version." Never guess an offset.
- **Re-swap support.** After swap #1 the stock needle is gone, so we persist the offset in a
  sidecar `.rockbox/.macrockpod-logo.json` `{ offset, firmwareBytes, originalBlobBase64,
  lastWrittenSha }`. Subsequent swaps use the saved offset after validating the firmware still
  matches (size + bytes at offset). If the firmware was reinstalled (validation fails), fall
  back to re-locating the stock needle.
- **Restore original.** Re-patches the saved offset with the original bytes (from the sidecar)
  or the shipped stock blob.
- **Atomic write.** Temp file on the same volume + rename. Never write in place.
- **Length invariants.** Replacement blob must be exactly 62,720 bytes; firmware length must be
  unchanged after patch.

## 5. UX

- **New home screen** with two choices: *Install Rockbox* (the existing 4-step wizard,
  unchanged) and *Change Boot Logo* (new flow). App boots to this screen instead of straight
  into the installer.
- **Logo flow:** select iPod (only Rockbox-installed ones listed) → pick image; choose fit
  mode (letterbox / crop / stretch) and pad color; live 320×98 preview → **Apply** → success
  screen with "Reset the iPod (toggle HOLD off, hold MENU+SELECT ~6s) to see the new logo" and
  a **Restore original logo** button.
- **Defaults:** fit = letterbox; pad color = black (user-selectable).

## 6. Testing

`test/logo.test.js` (Node, same style as `test/geometry.test.js`, run by `npm test`):

- `packRgb565LE` on the original logo's RGBA equals the shipped stock blob (golden test).
- `findStockLogo` returns a single offset in a synthetic firmware containing the blob; returns
  −1 when absent; errors on duplicate.
- `replaceLogo` round-trip: replace then restore yields the original buffer; length unchanged.

Fixtures stay small (the 62,720-byte stock blob + synthetic firmwares); the full 1.1 MB
firmware is not committed.

## 7. Out of scope (YAGNI)

- Other iPod models / screen sizes (this app targets iPod Video only).
- Swapping the logo during install (chosen design is standalone).
- Animated or multi-frame logos; the remote-LCD logo (iPod Video has none).
- Bundling a build toolchain to recompile firmware.

## 8. Files touched

- New: `lib/logo.js`, `test/logo.test.js`, `assets/stock-logo-ipodvideo.bin`.
- Modified: `main.js` (IPC handlers), `preload.js` (expose new IPC), `renderer.js` (logo flow
  + canvas), `index.html` (home screen + logo panels), `style.css` (styles), `package.json`
  (ensure `assets/` is bundled), `README.md` (document the feature).

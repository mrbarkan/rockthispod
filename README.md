# MacRockPod

Install [Rockbox](https://www.rockbox.org/) on an **iPod Video (5th / 5.5th generation)** straight from an Apple Silicon Mac — no Windows, no virtual machine, no command line.

It works on iFlash / SD‑modded iPods too, and auto‑detects the 2048‑byte‑sector quirk of the 5.5G that breaks most other tools.

---

## For users — installing Rockbox

### 1. Before you start
- A genuine **iPod Video 5G or 5.5G** (the click‑wheel one with a colour screen and video playback).
- The iPod must already have its **original Apple firmware** on it. If you just put in a fresh flash/SD card and it has never been set up, plug it into **Finder** (or the Apple Devices / iTunes app) and **Restore** it once first, then come back here.
- **Installing erases all music and data on the iPod.** Back up anything you want to keep.

### 2. Open the app
1. Download `MacRockPod.zip`, unzip it, and move **MacRockPod.app** to your Applications folder.
2. Double‑click it. (This build is notarized by Apple, so it opens normally. If you ever get a Gatekeeper warning, right‑click the app → **Open**.)

### 3. Grant Full Disk Access (one time)
macOS will not let *any* app write directly to a disk without this — it's the single most common reason installs fail.

1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Turn **ON** the toggle for **MacRockPod**.
3. **Quit MacRockPod completely and reopen it.** (macOS only applies the permission on a fresh launch.)

### 4. Install
1. Connect the iPod and put it in **Disk Mode** if needed (toggle **HOLD** on then off, then hold **MENU + SELECT** until it resets, then immediately hold **SELECT + PLAY**).
2. Select your iPod in the app, confirm, and check the safety box.
3. Enter your Mac password when prompted (needed once for raw‑disk access).
4. When it finishes: **Eject** the iPod in Finder, unplug it, then reset it (HOLD off, hold **MENU + SELECT** ~6 seconds). It boots into Rockbox.

### Dual boot (keep the Apple firmware)
The original Apple firmware is preserved. To start it instead of Rockbox, hold **MENU** during the reset (or flip the **HOLD** switch on right after resetting).

### Syncing music afterward
On macOS, copy music with the iPod in **Apple Disk Mode** for best stability on flash adapters: turn the **HOLD switch ON** before plugging in, which boots the Apple firmware's USB layer rather than Rockbox's. Then drag files onto the iPod's drive in Finder.

### Changing the boot logo
Once Rockbox is installed you can replace the logo that shows when it starts up, with any image you like — no reinstall, no password.

1. Connect the iPod with the **HOLD switch ON** so it mounts in disk mode.
2. Open the app and choose **Change Boot Logo** on the home screen.
3. Pick your iPod, then **Choose Image…** (PNG, JPG, etc.). The logo area is **320 × 98** pixels — pick how your image fits it:
   - **Letterbox** — whole image, padded with a background colour you choose.
   - **Crop** — fills the area, trimming the overflow.
   - **Stretch** — forced to fit, ignoring aspect ratio.
4. The preview shows exactly what will be written. Click **Apply Logo**, then **Eject** the iPod and reset it (HOLD off, hold **MENU + SELECT** ~6 seconds) to see it.

**Restore Original** puts the stock Rockbox logo back at any time. This is non‑destructive — it only rewrites the logo bytes inside `rockbox.ipod`, never the partition layout or your music. It works on supported Rockbox builds (the app locates the known stock logo); if a future build changes the logo it will say so and skip rather than risk the firmware.

### Troubleshooting
| Symptom | Fix |
| --- | --- |
| "Full Disk Access permission required" | Do step 3 above, then **quit and reopen** the app. |
| "No Apple firmware found on this iPod" | Restore the iPod once with Finder, let it boot to the Apple menu, then retry. |
| "The iPod disk is busy" | Quit Finder/Music windows touching the iPod, unplug/replug, retry. |
| Boots to **`ATA error: -11`** | Known iFlash/SSD adapter issue with the stock bootloader — open an issue; the fix is swapping in a newer bootloader (non‑destructive). |
| Nothing detected | Put the iPod in Disk Mode (see step 4) and click **Rescan**. |
| Boot logo: "No Rockbox iPod found" | The logo tool only lists iPods that already run Rockbox. Connect with **HOLD on** and **Rescan**. |
| Boot logo: "Could not locate the boot logo…" | This Rockbox build's logo differs from the known stock one, so the swap is unavailable on it. Nothing was changed. |

---

## For the maintainer — building & releasing

### Run from source
```bash
npm install
npm start
```

### Package an unsigned build (for local testing)
```bash
npm run package          # → dist/MacRockPod-darwin-arm64/MacRockPod.app
```
Unsigned builds run on *your* machine but show a Gatekeeper warning on anyone else's.

### Build a notarized, shareable release
You need an Apple Developer account, a **Developer ID Application** certificate in your login keychain, and an **app‑specific password**. Then:
```bash
SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
APPLE_ID="you@example.com" \
APPLE_TEAM_ID="TEAMID" \
APPLE_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx" \
npm run dist
```
This packages, signs with the hardened runtime + [`build/entitlements.mac.plist`](build/entitlements.mac.plist), submits to Apple's notary service, staples the ticket, and produces **`dist/MacRockPod.zip`** — the file to share. Full prerequisites are documented at the top of [`build/notarize.sh`](build/notarize.sh).

### How the install works
The 5.5G presents **2048‑byte logical sectors** over USB, so MBR partition entries must be written in 2048‑byte units (writing 512‑byte units silently corrupts the layout — the bug that defeats most ad‑hoc scripts). The app:
1. Pauses the macOS media daemons that grab the iPod on connect.
2. Reads the real partition geometry from `ipodpatcher --list` (works on Mac‑format *and* Windows‑format iPods, in the device's own sector units).
3. Writes a clean Windows‑format (MBR) partition table that **preserves the Apple firmware partition byte‑for‑byte** and creates a FAT32 data partition — using the detected sector size.
4. Formats the data partition (`newfs_msdos`).
5. Patches the Rockbox bootloader **into** the Apple firmware with `ipodpatcher --add-bootloader` (this is what enables dual boot).
6. Extracts the current Rockbox build onto the FAT32 volume.

The bundled `bin/ipodpatcher` is built from the Rockbox source in `rockbox-src/` (the upstream `utils/ipodpatcher`).

### How the boot-logo swap works
The iPod Video boot logo is `rockboxlogo.320x98x16.bmp`, embedded uncompressed in the main firmware `rockbox.ipod` as **RGB565, little‑endian** (320 × 98 = 62,720 bytes). The standalone logo tool:
1. Decodes and fits the chosen image to 320 × 98 on a `<canvas>` (letterbox/crop/stretch), then hands the raw RGBA to the main process — so it needs no image library and no `sips`.
2. Packs it to the native RGB565 format ([`lib/logo.js`](lib/logo.js)).
3. Locates the **stock logo** in `rockbox.ipod` by searching for the shipped reference blob [`assets/stock-logo-ipodvideo.bin`](assets/stock-logo-ipodvideo.bin) (must match exactly once), then overwrites those bytes in place — same length, so the firmware size and layout are untouched — via a temp‑file + atomic rename.
4. Saves the original bytes + offset to `.rockbox/.macrockpod-logo.json` on the iPod so re‑swapping and **Restore Original** keep working after the stock logo is gone.

It writes only the mounted FAT32 volume as the user, so unlike the installer it needs **no admin password or Full Disk Access**. The reference blob is regenerated from the Rockbox source with `node build/generate-stock-logo.js`; `npm test` golden‑checks it against a pinned sha256. The packer/locator/replacer are unit‑tested in [`test/logo.test.js`](test/logo.test.js).

> **Note on coverage:** the full flow is validated end‑to‑end on a 2048‑byte‑sector iPod Video 5.5G. The Mac‑format→Windows‑format conversion reuses upstream ipodpatcher's tested read path plus the validated MBR/format/patch sequence; if you're the first to run it on a *pristine* Apple‑formatted (APM) iPod, please confirm it and report back.

---

## Credits & license
- [Rockbox](https://www.rockbox.org/) — the open‑source firmware and the `ipodpatcher` tool (GPL).
- This installer is a convenience wrapper around those tools. Use at your own risk; it writes directly to disk and erases the iPod.

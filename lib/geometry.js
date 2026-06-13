// Pure geometry helpers for MacRockPod — no Electron/Node-fs dependencies, so
// they can be unit-tested in isolation (see test/geometry.test.js).
//
// The 5.5G iPod Video presents 2048-byte logical sectors over USB. MBR
// partition entries are in units of that logical sector size, so they must be
// written in 2048-byte units on these devices (512-byte units silently corrupt
// the layout). We never assume the sector size or firmware bounds — we read
// both from `ipodpatcher --list`, which reports them in the device's own sector
// units for Mac-format and Windows-format iPods alike.

// Parse `ipodpatcher --list` output.
// Returns { sectorSize, model, isMacpod, firmware: {start, end}, dataEnd }
// or throws an Error (message 'NO_FIRMWARE' when the iPod lacks Apple firmware).
function parseIpodpatcherList(out) {
  out = out || '';
  if (/\[ERR\]/.test(out)) {
    if (/firmware directory|No partition 0|Unknown version/.test(out)) {
      throw new Error('NO_FIRMWARE');
    }
    throw new Error('ipodpatcher could not read this iPod. See the console log above.');
  }

  const ssMatch = /Sector size is (\d+) bytes/.exec(out);
  const sectorSize = ssMatch ? parseInt(ssMatch[1], 10) : null;
  if (!sectorSize) throw new Error('Could not determine the iPod sector size.');

  // Partition rows: "[INFO]   0   63   81982   160.0   Empty (0x00)"
  const parts = [];
  const re = /^\s*(?:\[INFO\]\s*)?(\d+)\s+(\d+)\s+(\d+)\s+[\d.]+\s+(.+)$/gm;
  let m;
  while ((m = re.exec(out)) !== null) {
    parts.push({
      index: parseInt(m[1], 10),
      start: parseInt(m[2], 10),
      end: parseInt(m[3], 10),
      type: m[4].trim()
    });
  }
  const firmware = parts.find((p) => p.index === 0);
  const data = parts.find((p) => p.index === 1);
  if (!firmware || !data) throw new Error('Could not parse the iPod partition table.');

  const isMacpod = /macpod/i.test(out) || /HFS/i.test(data.type);
  const model = (/Ipod model:\s+(.+)/.exec(out) || [])[1];

  return {
    sectorSize,
    model: model ? model.trim() : 'iPod',
    isMacpod,
    firmware: { start: firmware.start, end: firmware.end },
    dataEnd: data.end
  };
}

// Build a canonical winpod MBR (one logical sector). Partition entries are in
// device-sector units, so the same code is correct for 512- and 2048-byte
// devices. The firmware partition is preserved; only the map + FAT32 data
// partition are (re)written.
function buildWinpodMbr(sectorSize, fwStart, fwSize, dataStart, dataSize) {
  const mbr = Buffer.alloc(sectorSize);
  const entry = (i, type, start, size) => {
    const o = 0x1be + i * 16;
    mbr[o] = 0x00;                                   // boot flag
    mbr[o + 1] = 0xfe; mbr[o + 2] = 0xff; mbr[o + 3] = 0xff; // CHS start (LBA filler)
    mbr[o + 4] = type;
    mbr[o + 5] = 0xfe; mbr[o + 6] = 0xff; mbr[o + 7] = 0xff; // CHS end
    mbr.writeUInt32LE(start >>> 0, o + 8);
    mbr.writeUInt32LE(size >>> 0, o + 12);
  };
  entry(0, 0x00, fwStart, fwSize);     // firmware ("Empty" type, but non-empty)
  entry(1, 0x0b, dataStart, dataSize); // W95 FAT32
  mbr[0x1fe] = 0x55;
  mbr[0x1ff] = 0xaa;
  return mbr;
}

// Given parsed geometry + the disk's total byte size, compute the winpod layout
// in device-sector units.
function computeLayout(geom, totalBytes) {
  const totalSectors = Math.floor(totalBytes / geom.sectorSize);
  const fwStart = geom.firmware.start;
  const fwSize = geom.firmware.end - geom.firmware.start + 1;
  const dataStart = fwStart + fwSize;
  const dataSize = totalSectors - dataStart;
  return { totalSectors, fwStart, fwSize, dataStart, dataSize };
}

module.exports = { parseIpodpatcherList, buildWinpodMbr, computeLayout };

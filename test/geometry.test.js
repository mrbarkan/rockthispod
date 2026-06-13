// Validates the geometry helpers against REAL data: the exact `ipodpatcher
// --list` output captured from the iPod that booted, and the known-good MBR
// bytes the repair wrote (which produced a working dual-boot Rockbox install).
//
// Run: node test/geometry.test.js

const assert = require('assert');
const { parseIpodpatcherList, buildWinpodMbr, computeLayout } = require('../lib/geometry');

let passed = 0;
const ok = (name) => { console.log(`  ok - ${name}`); passed++; };

// ---- Real captured output from the working 5.5G iPod Video (2048-byte) ----
const REAL_WINPOD_LIST = `
[INFO] Reading partition table from /dev/disk5
[INFO] Sector size is 2048 bytes
[INFO] Read XML info (9693 bytes)
[INFO] Part    Start Sector    End Sector   Size (MB)   Type
[INFO]    0              63         81982       160.0   Empty (0x00)
[INFO]    1           81983      93618175    182687.9   W95 FAT32 (0x0b)
[INFO] Ipod model: Video (aka 5th Generation) (32MB RAM) ("winpod")
`;

// Synthetic macpod variant: same physical firmware partition, HFS data, 2048b.
const REAL_MACPOD_LIST = `
[INFO] Reading partition table from /dev/disk5
[INFO] Sector size is 2048 bytes
[INFO] Part    Start Sector    End Sector   Size (MB)   Type
[INFO]    0              63         81982       160.0   Empty (0x00)
[INFO]    1           81983      93618175    182687.9   Apple HFS (0xaf)
[INFO] Ipod model: Video (aka 5th Generation) (32MB RAM) ("macpod")
`;

// A classic 512-byte-sector iPod Video (firmware partition starts at 63, size 80MB)
const LIST_512 = `
[INFO] Sector size is 512 bytes
[INFO] Part    Start Sector    End Sector   Size (MB)   Type
[INFO]    0              63        163903        80.0   Empty (0x00)
[INFO]    1          163904      60000000     29216.8   W95 FAT32 (0x0b)
[INFO] Ipod model: Video (aka 5th Generation) ("winpod")
`;

const NO_FW = `
[INFO] Reading partition table from /dev/disk5
[INFO] Sector size is 2048 bytes
[ERR]  Failed to read firmware directory - nimages=0
`;

// ---- parse: winpod ----
{
  const g = parseIpodpatcherList(REAL_WINPOD_LIST);
  assert.strictEqual(g.sectorSize, 2048);
  assert.strictEqual(g.isMacpod, false);
  assert.strictEqual(g.firmware.start, 63);
  assert.strictEqual(g.firmware.end, 81982);
  assert.strictEqual(g.dataEnd, 93618175);
  assert.match(g.model, /Video/);
  ok('parses real winpod --list (2048-byte)');
}

// ---- parse: macpod ----
{
  const g = parseIpodpatcherList(REAL_MACPOD_LIST);
  assert.strictEqual(g.isMacpod, true);
  assert.strictEqual(g.firmware.start, 63);
  assert.strictEqual(g.firmware.end, 81982);
  ok('parses macpod --list and flags isMacpod');
}

// ---- parse: 512-byte device ----
{
  const g = parseIpodpatcherList(LIST_512);
  assert.strictEqual(g.sectorSize, 512);
  assert.strictEqual(g.firmware.start, 63);
  assert.strictEqual(g.firmware.end, 163903);
  ok('parses a 512-byte-sector device');
}

// ---- parse: missing firmware ----
{
  assert.throws(() => parseIpodpatcherList(NO_FW), /NO_FIRMWARE/);
  ok('throws NO_FIRMWARE when Apple firmware is absent');
}

// ---- layout: matches the device that actually booted ----
{
  const g = parseIpodpatcherList(REAL_WINPOD_LIST);
  const TOTAL_BYTES = 191730024448; // diskutil-reported size of the real iPod
  const L = computeLayout(g, TOTAL_BYTES);
  assert.strictEqual(L.totalSectors, 93618176);
  assert.strictEqual(L.fwStart, 63);
  assert.strictEqual(L.fwSize, 81920);
  assert.strictEqual(L.dataStart, 81983);
  assert.strictEqual(L.dataSize, 93536193);
  assert.strictEqual(L.dataStart + L.dataSize, L.totalSectors); // data fills the disk
  ok('computeLayout reproduces the working device geometry');
}

// ---- MBR bytes: byte-for-byte match to the repair MBR that booted ----
{
  // From the validated repair: p1=[63,81920], p2=[81983,93536193], 2048b sector
  const mbr = buildWinpodMbr(2048, 63, 81920, 81983, 93536193);
  assert.strictEqual(mbr.length, 2048);

  // Partition entry 1 (firmware) at 0x1be
  assert.strictEqual(mbr[0x1be + 4], 0x00, 'fw type = 0x00');
  assert.strictEqual(mbr.readUInt32LE(0x1be + 8), 63, 'fw start = 63');
  assert.strictEqual(mbr.readUInt32LE(0x1be + 12), 81920, 'fw size = 81920');

  // Partition entry 2 (FAT32) at 0x1ce
  assert.strictEqual(mbr[0x1ce + 4], 0x0b, 'data type = 0x0b');
  assert.strictEqual(mbr.readUInt32LE(0x1ce + 8), 81983, 'data start = 81983');
  assert.strictEqual(mbr.readUInt32LE(0x1ce + 12), 93536193, 'data size');

  // Boot signature
  assert.strictEqual(mbr[0x1fe], 0x55);
  assert.strictEqual(mbr[0x1ff], 0xaa);

  // The exact 0x1b0..0x1ff window from the repair MBR that produced a booting
  // iPod (transcribed from the xxd dump). Partition entries start at 0x1be, so
  // entry 1's first bytes land at the tail of the 0x1b0 row.
  const KNOWN_GOOD = Buffer.from(
    '000000000000000000000000000000fe' + // 0x1b0  (0x1be=00 status, 0x1bf=fe CHS)
    'ffff00feffff3f0000000040010000fe' + // 0x1c0  (entry1: type 00, start 63, size 0x14000)
    'ffff0bfeffff3f400100c13f93050000' + // 0x1d0  (entry2: type 0b, start 81983, size 0x059333fc1)
    '00000000000000000000000000000000' + // 0x1e0
    '0000000000000000000000000000' +     // 0x1f0..0x1fd
    '55aa',                              // 0x1fe boot sig
    'hex'
  );
  assert.ok(mbr.subarray(0x1b0, 0x200).equals(KNOWN_GOOD),
    'MBR tail matches the validated repair bytes exactly');
  ok('buildWinpodMbr reproduces the exact MBR that booted');
}

// ---- 512-byte device produces a sane, sector-correct MBR ----
{
  const g = parseIpodpatcherList(LIST_512);
  const L = computeLayout(g, 60000000 * 512); // ~30GB
  const mbr = buildWinpodMbr(g.sectorSize, L.fwStart, L.fwSize, L.dataStart, L.dataSize);
  assert.strictEqual(mbr.length, 512);
  assert.strictEqual(mbr.readUInt32LE(0x1be + 8), 63);
  assert.strictEqual(mbr.readUInt32LE(0x1ce + 8), 163904); // fwStart + fwSize
  assert.strictEqual(mbr[0x1fe], 0x55);
  ok('512-byte device yields a one-sector (512B) MBR in correct units');
}

console.log(`\n${passed} assertions passed.`);

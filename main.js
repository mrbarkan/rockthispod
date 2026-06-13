const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const https = require('https');
const { parseIpodpatcherList, buildWinpodMbr, computeLayout } = require('./lib/geometry');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 650,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 15, y: 15 },
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile('index.html');
  // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Reload background daemons if we paused them
  reloadAgents();
  app.quit();
});

// ---------------------------------------------------------------------------
// Command helpers
// ---------------------------------------------------------------------------

function runCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ success: false, error: err.message, stdout, stderr });
      else resolve({ success: true, stdout, stderr });
    });
  });
}

// Run a command with administrator privileges. When the app already runs as
// root we shell out directly; otherwise we use one osascript prompt. NOTE: even
// as root, macOS TCC requires the *app* (MacRockPod.app) to have Full Disk
// Access before it can touch /dev/rdiskN - see the FDA guidance in the UI.
function runAdminCommand(cmd) {
  const isRoot = process.getuid && process.getuid() === 0;
  if (isRoot) {
    return runCommand(cmd);
  }
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const appleScript = `do shell script "${escaped}" with administrator privileges`;
  return runCommand(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`);
}

function reloadAgents() {
  exec('launchctl load -w /System/Library/LaunchAgents/com.apple.AMPDeviceDiscoveryAgent.plist 2>/dev/null');
  exec('launchctl load -w /System/Library/LaunchAgents/com.apple.AMPLibraryAgent.plist 2>/dev/null');
}

// ---------------------------------------------------------------------------
// Device scan
// ---------------------------------------------------------------------------

ipcMain.handle('scan-ipods', async () => {
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

    // This disk's own partition scheme decides macpod (APM) vs winpod (MBR)
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
});

ipcMain.handle('is-root', () => process.getuid && process.getuid() === 0);

ipcMain.on('open-fda-settings', () => {
  exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"');
});

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        downloadFile(response.headers.location, destPath, onProgress).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: server returned ${response.statusCode} for ${url}`));
        return;
      }
      const total = parseInt(response.headers['content-length'], 10);
      let downloaded = 0;
      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total) onProgress(downloaded, total);
      });
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// ---------------------------------------------------------------------------
// Install
// (geometry helpers live in lib/geometry.js so they can be unit-tested)
// ---------------------------------------------------------------------------

ipcMain.on('run-install-task', async (event, config) => {
  const { diskId, model } = config; // model is always an iPod Video target id
  const ipodpatcherPath = path.join(__dirname, 'bin', 'ipodpatcher');

  const sendLog = (text) => { console.log(text); event.reply('task-log', text); };
  const sendProgress = (step, percent, status) => event.reply('task-progress', { step, percent, status });

  const tempDir = app.getPath('temp');
  const blDest = path.join(tempDir, `bootloader-${model}.ipod`);
  const rbDest = path.join(tempDir, `rockbox-${model}.zip`);
  const mbrDest = path.join(tempDir, `mbr-${diskId}.bin`);
  const dev = `/dev/${diskId}`;
  const rdev = `/dev/r${diskId}`;

  try {
    if (!diskId) throw new Error('No iPod was selected.');

    // Step 1: pause the macOS daemons that grab the iPod the instant it mounts
    sendProgress('freeze', 5, 'Pausing conflicting system daemons...');
    sendLog('[INFO] Suspending AMPDeviceDiscoveryAgent / AMPLibraryAgent...');
    await runCommand('launchctl unload -w /System/Library/LaunchAgents/com.apple.AMPDeviceDiscoveryAgent.plist 2>/dev/null');
    await runCommand('launchctl unload -w /System/Library/LaunchAgents/com.apple.AMPLibraryAgent.plist 2>/dev/null');

    // Step 2: download bootloader + build up front, so we fail early if offline
    const blUrl = `https://download.rockbox.org/bootloader/ipod/bootloader-${model}.ipod`;
    sendProgress('download', 10, 'Downloading Rockbox bootloader...');
    sendLog(`[INFO] Fetching ${blUrl}`);
    await downloadFile(blUrl, blDest, (dl, tot) => {
      sendProgress('download', 10 + Math.round((dl / tot) * 5), `Downloading bootloader (${Math.round((dl / tot) * 100)}%)...`);
    });

    const rbUrl = `https://build.rockbox.org/data/rockbox-${model}.zip`;
    sendLog(`[INFO] Fetching ${rbUrl}`);
    await downloadFile(rbUrl, rbDest, (dl, tot) => {
      sendProgress('download', 15 + Math.round((dl / tot) * 15), `Downloading Rockbox build (${Math.round((dl / tot) * 100)}%)...`);
    });
    sendLog('[INFO] Downloads complete.');

    // Step 3: read the real geometry from ipodpatcher (works on macpod + winpod)
    sendProgress('inspect', 32, 'Reading iPod partition geometry...');
    const listRes = await runAdminCommand(`"${ipodpatcherPath}" ${dev} --list 2>&1`);
    if (listRes.stdout && listRes.stdout.trim()) sendLog(listRes.stdout.trim());
    if (!listRes.success && !listRes.stdout) {
      throw new Error(listRes.stderr || listRes.error || 'ipodpatcher --list failed');
    }
    const geom = parseIpodpatcherList(listRes.stdout || '');
    sendLog(`[INFO] Detected: ${geom.model} (${geom.isMacpod ? 'macpod' : 'winpod'}), ${geom.sectorSize}-byte sectors.`);

    // Total sectors from diskutil (authoritative), cross-checked against --list
    const dInfo = await runCommand(`diskutil info ${diskId}`);
    const bytesMatch = /Disk Size:.*\((\d+)\s+Bytes\)/.exec(dInfo.stdout || '');
    if (!bytesMatch) throw new Error('Could not read the iPod disk size.');

    const { totalSectors, fwStart, fwSize, dataStart, dataSize } =
      computeLayout(geom, parseInt(bytesMatch[1], 10));
    if (dataSize <= 0) throw new Error('Computed data partition size is invalid - aborting.');
    sendLog(`[INFO] Layout: firmware [${fwStart}..${geom.firmware.end}], data [${dataStart}..${totalSectors - 1}] (${geom.sectorSize}-byte units).`);

    // Step 4: write a clean winpod MBR (preserves firmware, never touches it)
    sendProgress('partition', 45, 'Writing partition table (MBR)...');
    const mbr = buildWinpodMbr(geom.sectorSize, fwStart, fwSize, dataStart, dataSize);
    fs.writeFileSync(mbrDest, mbr);
    sendLog('[INFO] Unmounting and writing MBR...');
    const mbrRes = await runAdminCommand(
      `/usr/sbin/diskutil unmountDisk force ${dev} && dd if="${mbrDest}" of=${rdev} bs=${geom.sectorSize} count=1`
    );
    fs.unlink(mbrDest, () => {});
    if (!mbrRes.success) throw new Error(`Writing the partition table failed: ${mbrRes.stderr || mbrRes.error || mbrRes.stdout}`);

    // Wait for the kernel to re-read the new partition table
    sendLog('[INFO] Waiting for macOS to re-read the partition table...');
    let tableReady = false;
    for (let i = 0; i < 20 && !tableReady; i++) {
      const probe = await runCommand(`diskutil info ${diskId}s2`);
      if (probe.success && /Partition Offset/.test(probe.stdout)) tableReady = true;
      else await new Promise((r) => setTimeout(r, 1000));
    }
    if (!tableReady) throw new Error('macOS did not pick up the new partition table. Unplug/replug the iPod and run the installer again.');

    // Step 5: format the data partition FAT32
    sendProgress('partition', 58, 'Formatting data partition (FAT32)...');
    sendLog('[INFO] Creating FAT32 filesystem on the data partition...');
    const fmtRes = await runAdminCommand(`/usr/sbin/diskutil unmountDisk force ${dev} && /sbin/newfs_msdos -F 32 -v IPOD ${rdev}s2`);
    if (!fmtRes.success) throw new Error(`Formatting the data partition failed: ${fmtRes.stderr || fmtRes.error || fmtRes.stdout}`);
    sendLog('[INFO] FAT32 data partition created.');

    // Step 6: patch the Rockbox bootloader into the real Apple firmware
    sendProgress('bootloader', 70, 'Installing bootloader into Apple firmware...');
    sendLog('[INFO] Patching bootloader with ipodpatcher --add-bootloader...');
    const patchRes = await runAdminCommand(`/usr/sbin/diskutil unmountDisk force ${dev} ; "${ipodpatcherPath}" ${dev} --add-bootloader "${blDest}" 2>&1`);
    if (patchRes.stdout && patchRes.stdout.trim()) sendLog(patchRes.stdout.trim());
    if (!patchRes.success && !patchRes.stdout) throw new Error(`Bootloader install failed: ${patchRes.stderr || patchRes.error}`);
    if (/\[ERR\]/.test(patchRes.stdout || '')) throw new Error('ipodpatcher reported an error installing the bootloader - see the log above.');
    sendLog('[INFO] Bootloader installed (Apple firmware preserved for dual boot).');

    // Step 7: extract the Rockbox build onto the FAT32 volume
    sendProgress('payload-extract', 82, 'Mounting data partition...');
    await runCommand(`diskutil mountDisk ${dev}`);
    let mountPath = null;
    for (let i = 0; i < 15 && !mountPath; i++) {
      for (const suffix of ['s2', 's1']) {
        const mc = await runCommand(`diskutil info ${diskId}${suffix}`);
        const mm = /Mount Point:\s+(\/.+)/.exec(mc.stdout || '');
        if (mm) { mountPath = mm[1].trim(); break; }
      }
      if (!mountPath) { await runCommand(`diskutil mountDisk ${dev}`); await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!mountPath || !fs.existsSync(mountPath)) {
      throw new Error('The FAT32 volume did not mount. Unplug/replug the iPod and run the installer again - the bootloader and format are already done, so it will skip straight to copying files.');
    }

    sendProgress('payload-extract', 90, 'Extracting Rockbox onto the iPod...');
    sendLog(`[INFO] Extracting Rockbox to ${mountPath}...`);
    const unzipRes = await runCommand(`unzip -oq "${rbDest}" -d "${mountPath}"`);
    if (!unzipRes.success) throw new Error(`Extracting the Rockbox files failed: ${unzipRes.stderr || unzipRes.stdout}`);
    const dotRockbox = path.join(mountPath, '.rockbox');
    if (fs.existsSync(dotRockbox)) await runCommand(`chflags nohidden "${dotRockbox}"`);
    sendLog('[INFO] Rockbox files installed.');

    // Done
    sendProgress('complete', 100, 'Installation successful!');
    sendLog('[INFO] Done! Eject the iPod in Finder, unplug it, then reset: toggle HOLD off and hold MENU+SELECT for ~6 seconds.');
    sendLog('[INFO] Dual boot: hold MENU during the reset (or flip HOLD on right after) to start the original Apple firmware instead.');
    fs.unlink(blDest, () => {});
    fs.unlink(rbDest, () => {});
    reloadAgents();

  } catch (err) {
    const errMsg = err.message || 'Unknown error';
    let displayMsg = 'Installation failed!';

    if (errMsg === 'NO_FIRMWARE') {
      displayMsg = 'No Apple firmware found on this iPod';
      sendLog('\n[HELP] This iPod has no valid Apple firmware on it (common on freshly flash-modded carts).');
      sendLog('[HELP] Rockbox installs *alongside* the Apple firmware, so it has to exist first.');
      sendLog('[HELP] Fix: restore the iPod once with Finder (or iTunes/Apple Devices), let it boot to the Apple menu, then run this installer again.\n');
      sendProgress('error', 0, displayMsg);
      reloadAgents();
      return;
    }
    if (errMsg.includes('User canceled') || errMsg.includes('-128')) {
      displayMsg = 'Administrator authorization was cancelled';
      sendLog('[HELP] The macOS password prompt was cancelled. Run the install again and enter your password to allow raw disk access.');
    } else if (errMsg.includes('Resource busy')) {
      displayMsg = 'The iPod disk is busy';
      sendLog('[HELP] Something else is using the iPod (Finder, Music, or a stuck mount). Unplug/replug it and try again.');
    } else if (errMsg.includes('Operation not permitted') || errMsg.includes('Permission denied') || errMsg.includes('not permitted')) {
      displayMsg = 'Full Disk Access permission required';
      sendLog('\n[HELP] macOS blocked raw disk access. MacRockPod needs Full Disk Access.');
      sendLog('[HELP] 1. Open System Settings > Privacy & Security > Full Disk Access.');
      sendLog('[HELP] 2. Turn ON the toggle for "MacRockPod".');
      sendLog('[HELP] 3. Quit MacRockPod completely and reopen it, then try again.\n');
    }
    sendLog(`[FATAL ERROR] ${errMsg}`);
    sendProgress('error', 0, displayMsg);
    reloadAgents();
  }
});

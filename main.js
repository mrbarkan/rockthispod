const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const https = require('https');

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
  mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Reload background daemons if we stopped them
  exec('launchctl load -w /System/Library/LaunchAgents/com.apple.AMPDeviceDiscoveryAgent.plist 2>/dev/null');
  exec('launchctl load -w /System/Library/LaunchAgents/com.apple.AMPLibraryAgent.plist 2>/dev/null');
  
  if (process.platform !== 'darwin') {
    app.quit();
  } else {
    app.quit(); // Explicit quit on Mac since this is a single-window utility
  }
});

// Helper: Run command asynchronously
function runCommand(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) resolve({ success: false, error: err.message, stdout, stderr });
      else resolve({ success: true, stdout, stderr });
    });
  });
}

// Helper: Run elevated/admin command
function runAdminCommand(cmd) {
  const isRoot = process.getuid && process.getuid() === 0;
  if (isRoot) {
    return runCommand(cmd);
  } else {
    const escapedCmd = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const appleScript = `do shell script "${escapedCmd}" with administrator privileges`;
    return runCommand(`osascript -e '${appleScript}'`);
  }
}

// IPC Handler: Scan for connected iPods
ipcMain.handle('scan-ipods', async () => {
  console.log('[BACKEND] Received scan-ipods IPC request');
  const listRes = await runCommand('diskutil list');
  if (!listRes.success) {
    console.error('[BACKEND] diskutil list failed:', listRes.error);
    return [];
  }
  
  const stdout = listRes.stdout;
  const disks = [];
  const regex = /\/dev\/(disk\d+)\s+\(external,\s+physical\):/g;
  let match;
  while ((match = regex.exec(stdout)) !== null) {
    disks.push(match[1]);
  }
  console.log('[BACKEND] Detected external physical disks:', disks);

  const ipods = [];
  for (const disk of disks) {
    console.log(`[BACKEND] Querying diskutil info for ${disk}...`);
    const infoRes = await runCommand(`diskutil info ${disk}`);
    if (infoRes.success) {
      const infoStr = infoRes.stdout;
      const mediaTypeMatch = /Media Type:\s+(.+)/.exec(infoStr);
      const mediaNameMatch = /Device \/ Media Name:\s+(.+)/.exec(infoStr);
      const diskSizeMatch = /Disk Size:\s+(.+)/.exec(infoStr);
      const contentMatch = /Content \(IOContent\):\s+(.+)/.exec(infoStr);

      const mediaType = mediaTypeMatch ? mediaTypeMatch[1].trim() : '';
      const mediaName = mediaNameMatch ? mediaNameMatch[1].trim() : '';
      const size = diskSizeMatch ? diskSizeMatch[1].trim() : 'Unknown';
      const content = contentMatch ? contentMatch[1].trim() : '';

      console.log(`[BACKEND] Disk ${disk} metadata: mediaType="${mediaType}", mediaName="${mediaName}", content="${content}"`);

      const isIpod = mediaType.toLowerCase().includes('ipod') || mediaName.toLowerCase().includes('ipod') || content.toLowerCase().includes('apple_mdfw');
      console.log(`[BACKEND] isIpod evaluation for ${disk}:`, isIpod);
      
      if (isIpod) {
        // Try to get volume labels
        const volNames = [];
        const lines = stdout.split('\n');
        let inDiskBlock = false;
        for (const line of lines) {
          if (line.startsWith(`/dev/${disk} `)) {
            inDiskBlock = true;
            continue;
          }
          if (inDiskBlock && line.startsWith('/dev/disk') && !line.startsWith(`/dev/${disk}`)) {
            break;
          }
          if (inDiskBlock) {
            const partMatch = /\s+\d+:\s+(\S+)\s+(.*?)\s+(\d+(\.\d+)?\s+[KMG]B)\s+(disk\d+s\d+)/.exec(line);
            if (partMatch) {
              const partType = partMatch[1];
              const label = partMatch[2].trim();
              if (label && label !== partType && !label.startsWith('Container') && !label.startsWith('EFI')) {
                volNames.push(label);
              }
            }
          }
        }

        const isMacPod = content.includes('Apple_partition_scheme') || infoStr.includes('Apple_partition_scheme') || stdout.includes('Apple_partition_map');

        const ipodObj = {
          id: disk,
          name: mediaName || 'iPod',
          size: size.split('(')[0].trim(),
          type: isMacPod ? 'macpod' : 'winpod',
          volumeName: volNames.join(', ') || 'IPOD'
        };
        console.log(`[BACKEND] Matching iPod found, pushing to devices:`, ipodObj);
        ipods.push(ipodObj);
      }
    }
  }
  return ipods;
});

// IPC Handler: Check DFU devices for iPod Classic
ipcMain.handle('scan-dfu', async () => {
  const mks5lbootPath = path.join(__dirname, 'bin', 'mks5lboot');
  const res = await runCommand(`"${mks5lbootPath}" --dfuscan`);
  if (res.success && res.stdout.includes('iPod Classic found')) {
    return { found: true, details: res.stdout.trim() };
  }
  return { found: false, log: res.stdout || res.stderr };
});

// IPC Handler: Check if running as root
ipcMain.handle('is-root', () => {
  return process.getuid && process.getuid() === 0;
});

// IPC Handler: Open macOS FDA settings
ipcMain.on('open-fda-settings', () => {
  exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"');
});

// Helper: Download files with progress
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = https.get(url, (response) => {
      // Handle redirects
      if (response.statusCode === 301 || response.statusCode === 302) {
        downloadFile(response.headers.location, destPath, onProgress).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Server returned status code ${response.statusCode}`));
        return;
      }

      const total = parseInt(response.headers['content-length'], 10);
      let downloaded = 0;

      response.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total) {
          onProgress(downloaded, total);
        }
      });

      response.pipe(file);

      file.on('finish', () => {
        file.close();
        resolve();
      });
    });

    request.on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// IPC Handler: Run Install Task
ipcMain.on('run-install-task', async (event, config) => {
  const { diskId, model, isClassic } = config;
  const ipodpatcherPath = path.join(__dirname, 'bin', 'ipodpatcher');
  const mks5lbootPath = path.join(__dirname, 'bin', 'mks5lboot');
  
  const sendLog = (text) => {
    console.log(text);
    event.reply('task-log', text);
  };
  const sendProgress = (step, percent, status) => event.reply('task-progress', { step, percent, status });

  try {
    // Step 1: Freeze macOS System Daemons
    sendProgress('freeze', 10, 'Freezing system daemons...');
    sendLog('[INFO] Suspending com.apple.AMPDeviceDiscoveryAgent...');
    await runCommand('launchctl unload -w /System/Library/LaunchAgents/com.apple.AMPDeviceDiscoveryAgent.plist 2>/dev/null');
    sendLog('[INFO] Suspending com.apple.AMPLibraryAgent...');
    await runCommand('launchctl unload -w /System/Library/LaunchAgents/com.apple.AMPLibraryAgent.plist 2>/dev/null');

    // Step 2: Unmount & Partition / Convert
    sendProgress('partition', 30, 'Unmounting & converting partition table...');
    sendLog(`[INFO] Unmounting disk /dev/${diskId}...`);
    const unmountRes = await runCommand(`diskutil unmountDisk /dev/${diskId}`);
    if (!unmountRes.success) {
      sendLog(`[WARN] Unmount failed: ${unmountRes.stderr || unmountRes.stdout}. Attempting force unmount...`);
      await runCommand(`diskutil unmountDisk force /dev/${diskId}`);
    }

    if (!isClassic) {
      sendLog('[INFO] Formatting iPod Video to dual-partition MBR layout...');
      
      // Query diskutil info to get exact size and block size
      sendLog(`[INFO] Querying disk info for ${diskId}...`);
      const infoRes = await runCommand(`diskutil info ${diskId}`);
      if (!infoRes.success) {
        throw new Error(`Failed to query disk info: ${infoRes.stderr || infoRes.stdout}`);
      }
      const infoStr = infoRes.stdout;
      
      const totalBytesMatch = /Disk Size:\s+.*\((\d+)\s+Bytes\)/.exec(infoStr);
      if (!totalBytesMatch) {
        throw new Error('Could not parse disk size from diskutil info!');
      }
      const totalBytes = parseInt(totalBytesMatch[1], 10);
      
      const blockSizeMatch = /Device Block Size:\s+(\d+)\s+Bytes/.exec(infoStr);
      const deviceBlockSize = blockSizeMatch ? parseInt(blockSizeMatch[1], 10) : 512;
      
      sendLog(`[INFO] Disk size: ${totalBytes} Bytes. Block size: ${deviceBlockSize} Bytes.`);
      
      // Generate custom MBR sector matching device block size
      const mbr = Buffer.alloc(deviceBlockSize);
      const totalSectors = Math.floor(totalBytes / 512);
      
      // Partition 1 (Firmware): start 64, size 163840, type 0x00
      mbr[446 + 0] = 0x00; // bootable
      mbr[446 + 4] = 0x00; // type (0x00 = empty/firmware)
      mbr.writeUInt32LE(64, 446 + 8);
      mbr.writeUInt32LE(163840, 446 + 12);
      
      // Partition 2 (Data): start 163904, size totalSectors - 163904, type 0x0B
      mbr[462 + 0] = 0x80; // bootable (active)
      mbr[462 + 4] = 0x0B; // type (0x0B = FAT32)
      mbr.writeUInt32LE(163904, 462 + 8);
      mbr.writeUInt32LE(totalSectors - 163904, 462 + 12);
      
      // Boot signature
      mbr[510] = 0x55;
      mbr[511] = 0xAA;
      
      const tempDir = app.getPath('temp');
      const tempMbrPath = path.join(tempDir, `mbr_${diskId}.bin`);
      fs.writeFileSync(tempMbrPath, mbr);
      
      sendLog('[INFO] Writing custom MBR partition structures to raw sectors...');
      const writeMbrRes = await runAdminCommand(`diskutil unmountDisk force /dev/${diskId} && dd if="${tempMbrPath}" of=/dev/r${diskId} bs=${deviceBlockSize} count=1`);
      if (!writeMbrRes.success) {
        throw new Error(`Failed to write iPod MBR partition table: ${writeMbrRes.stderr || writeMbrRes.stdout}`);
      }
      fs.unlink(tempMbrPath, () => {});
 
      // Check if original Apple firmware already exists at LBA 64 (offset 32768 bytes)
      let hasOriginalFw = false;
      try {
        const readBuf = Buffer.alloc(deviceBlockSize);
        const fd = fs.openSync(`/dev/${diskId}`, 'r');
        fs.readSync(fd, readBuf, 0, deviceBlockSize, 32768);
        fs.closeSync(fd);
        
        const appleStopSignStr = "{{~~  /-----\\   ";
        if (readBuf.toString('ascii', 0, appleStopSignStr.length) === appleStopSignStr) {
          const ososLen = readBuf.readUInt32LE(0x210);
          if (ososLen > 1024 * 1024) {
            hasOriginalFw = true;
            sendLog('[INFO] Valid original Apple firmware detected on partition. Preserving original firmware.');
          } else {
            sendLog('[INFO] Mock/invalid Apple firmware directory detected.');
          }
        }
      } catch (err) {
        sendLog(`[WARN] Could not read existing sector: ${err.message}`);
      }

      if (!hasOriginalFw) {
        sendLog('[WARN] No original Apple firmware detected on this partition.');
        sendLog('[WARN] To ensure a bootable iPod, you should first restore the device via Finder/iTunes.');
        sendLog('[INFO] Injecting Apple copyright and firmware directory signatures for compatibility...');

        const sigBuf = Buffer.alloc(deviceBlockSize);
        const appleStopSignStr = 
          "{{~~  /-----\\   " +
          "{{~~ /       \\  " +
          "{{~~|         | " +
          "{{~~| S T O P | " +
          "{{~~|         | " +
          "{{~~ \\       /  " +
          "{{~~  \\-----/   " +
          "Copyright(C) 200" +
          "1 Apple Computer" +
          ", Inc.----------" +
          "----------------" +
          "----------------" +
          "----------------" +
          "----------------" +
          "----------------" +
          "---------------";
        
        sigBuf.write(appleStopSignStr, 0, 'ascii');
        sigBuf[255] = 0x00; // Null terminator
        
        // Write firmware directory headers at 0x100
        sigBuf.write(']ih[', 0x100, 'ascii');
        sigBuf.writeUInt32LE(0, 0x104); // diroffset = 0
        sigBuf.writeUInt16LE(2, 0x10A); // version = 2
        
        // Write mock directory entry for FTYPE_OSOS (soso) at 0x200
        sigBuf.write('!ATA', 0x200, 'ascii');
        sigBuf.write('soso', 0x204, 'ascii');
        sigBuf.writeUInt32LE(0, 0x208); // id = 0
        sigBuf.writeUInt32LE(1024, 0x20c); // devOffset = 1024
        sigBuf.writeUInt32LE(16384, 0x210); // len = 16KB
        sigBuf.writeUInt32LE(0, 0x214); // addr = 0
        sigBuf.writeUInt32LE(0, 0x218); // entryOffset = 0
        sigBuf.writeUInt32LE(0, 0x21c); // chksum = 0
        sigBuf.writeUInt32LE(0xb000, 0x220); // vers = 0xb000
        sigBuf.writeUInt32LE(0, 0x224); // loadAddr = 0
        
        const tempSigPath = path.join(tempDir, `sig_${diskId}.bin`);
        fs.writeFileSync(tempSigPath, sigBuf);
        
        const seekVal = 32768 / deviceBlockSize;
        const writeSigRes = await runAdminCommand(`dd if="${tempSigPath}" of=/dev/r${diskId} bs=${deviceBlockSize} seek=${seekVal} count=1`);
        if (!writeSigRes.success) {
          throw new Error(`Failed to inject Apple copyright signature: ${writeSigRes.stderr || writeSigRes.stdout}`);
        }
        sendLog('[INFO] Apple copyright and firmware directory signatures injected successfully.');
        fs.unlink(tempSigPath, () => {});
      }
      
      sendLog('[INFO] MBR written successfully. Reloading disk partition layout...');
      await runCommand(`diskutil unmountDisk force /dev/${diskId}`);
      await new Promise(r => setTimeout(r, 2000));
      
      sendLog('[INFO] Creating FAT32 filesystem on data partition (Partition 2)...');
      const formatRes = await runAdminCommand(`diskutil unmountDisk force /dev/${diskId} && newfs_msdos -F 32 -v IPOD /dev/r${diskId}s2`);
      if (!formatRes.success) {
        throw new Error(`Failed to format data partition: ${formatRes.stderr || formatRes.stdout}`);
      }
      sendLog('[INFO] FAT32 data partition formatted successfully.');
    } else {
      sendLog('[INFO] iPod Classic detected. Partitioning to MBR FAT32 natively via diskutil...');
      const partRes = await runCommand(`diskutil partitionDisk ${diskId} MBR "MS-DOS FAT32" IPOD 0`);
      if (!partRes.success) {
        throw new Error(`NATIVE Partitioning failed: ${partRes.stderr || partRes.stdout}`);
      }
      sendLog(partRes.stdout);
    }

    // Step 3: Flash Rockbox Bootloader
    sendProgress('bootloader', 50, 'Injecting custom Rockbox bootloader...');
    const blUrl = isClassic 
      ? 'https://download.rockbox.org/bootloader/ipod/bootloaders.zip' // We fetch official packages
      : `https://download.rockbox.org/bootloader/ipod/bootloader-${model}.ipod`;
      
    const tempDir = app.getPath('temp');
    const blDest = path.join(tempDir, isClassic ? 'bootloaders.zip' : `bootloader-${model}.ipod`);
    
    sendLog(`[INFO] Fetching bootloader binary from ${blUrl}...`);
    await downloadFile(blUrl, blDest, (dl, tot) => {
      const pct = Math.round((dl / tot) * 100);
      sendProgress('bootloader', 50 + Math.round(pct * 0.1), `Downloading bootloader (${pct}%)...`);
    });

    sendLog('[INFO] Writing bootloader to storage tracks...');
    if (!isClassic) {
      const flashRes = await runAdminCommand(`diskutil unmountDisk /dev/${diskId} && "${ipodpatcherPath}" /dev/${diskId} --add-bootloader "${blDest}"`);
      if (!flashRes.success) {
        throw new Error(`Flashing bootloader failed: ${flashRes.stderr || flashRes.stdout}`);
      }
      sendLog(flashRes.stdout);
    } else {
      // Classic DFU mode bootloader install
      sendLog('[USER] Ensure your iPod Classic is connected in DFU mode...');
      sendLog('[INFO] Unzipping bootloader package...');
      const zipExtractDir = path.join(tempDir, 'ipod6g_bl');
      fs.mkdirSync(zipExtractDir, { recursive: true });
      await runCommand(`unzip -o "${blDest}" -d "${zipExtractDir}"`);
      
      const classicBlFile = path.join(zipExtractDir, 'bootloader-ipod6g.ipod');
      if (!fs.existsSync(classicBlFile)) {
        throw new Error('Bootloader file bootloader-ipod6g.ipod not found in downloaded package!');
      }

      sendLog('[INFO] Uploading bootstrap patch via DFU protocols...');
      const dfuRes = await runAdminCommand(`"${mks5lbootPath}" --bl-inst "${classicBlFile}"`);
      if (!dfuRes.success) {
        throw new Error(`DFU installer failed: ${dfuRes.stderr || dfuRes.stdout}`);
      }
      sendLog(dfuRes.stdout);
    }

    // Step 4: Download Rockbox OS Payload
    sendProgress('payload-download', 70, 'Downloading Rockbox OS payload...');
    const rbModel = isClassic ? 'ipod6g' : model;
    const rbUrl = `https://build.rockbox.org/data/rockbox-${rbModel}.zip`;
    const rbDest = path.join(tempDir, `rockbox-${rbModel}.zip`);

    sendLog(`[INFO] Fetching Rockbox OS archive from ${rbUrl}...`);
    await downloadFile(rbUrl, rbDest, (dl, tot) => {
      const pct = Math.round((dl / tot) * 100);
      sendProgress('payload-download', 70 + Math.round(pct * 0.15), `Downloading Rockbox OS (${pct}%)...`);
    });

    // Step 5: Extract Payload & Finalize Structures
    sendProgress('payload-extract', 90, 'Deploying payload to disk...');
    
    // Find mount point for FAT32 partition
    let mountPath = `/Volumes/IPOD`;
    sendLog('[INFO] Waiting for drive volume to mount...');
    // Poll diskutil to see if the partition is mounted, or try mounting it
    await runCommand(`diskutil mountDisk /dev/${diskId}`);
    
    let mountFound = false;
    for (let attempts = 0; attempts < 10; attempts++) {
      // Check both s2 (standard winpod layout) and s1 (single partition fallback)
      for (const partSuffix of ['s2', 's1']) {
        const mountCheck = await runCommand(`diskutil info ${diskId}${partSuffix}`);
        if (mountCheck.success && mountCheck.stdout.includes('Mount Point:')) {
          const match = /Mount Point:\s+(.+)/.exec(mountCheck.stdout);
          if (match) {
            mountPath = match[1].trim();
            mountFound = true;
            break;
          }
        }
      }
      if (mountFound) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    
    sendLog(`[INFO] Deploying components to destination: ${mountPath}`);
    if (!fs.existsSync(mountPath)) {
      throw new Error(`Mount point ${mountPath} is not accessible!`);
    }

    sendLog('[INFO] Extracting Rockbox structures...');
    const unzipRes = await runCommand(`unzip -o "${rbDest}" -d "${mountPath}"`);
    if (!unzipRes.success) {
       throw new Error(`Payload extraction failed: ${unzipRes.stderr || unzipRes.stdout}`);
    }
    sendLog('[INFO] Extraction completed.');

    sendLog('[INFO] Adjusting hidden directory visibility flags...');
    const dotRockbox = path.join(mountPath, '.rockbox');
    if (fs.existsSync(dotRockbox)) {
      await runCommand(`chflags nohidden "${dotRockbox}"`);
    }

    sendLog('[INFO] Optimizing bootloader signatures...');
    const srcExec = path.join(dotRockbox, 'rockbox.ipod');
    const destExec = path.join(mountPath, 'bootloader.ipod');
    if (fs.existsSync(srcExec)) {
      fs.copyFileSync(srcExec, destExec);
      sendLog('[INFO] bootloader.ipod successfully mirrored to root level.');
    } else {
      sendLog('[WARN] rockbox.ipod was not found in the extracted files. Dual-boot might need stock fallback.');
    }

    // Step 6: Finished
    sendProgress('complete', 100, 'Installation successful!');
    sendLog('[INFO] Cleanup temporary download objects...');
    fs.unlink(blDest, () => {});
    fs.unlink(rbDest, () => {});
    
    // Reload agents
    exec('launchctl load -w /System/Library/LaunchAgents/com.apple.AMPDeviceDiscoveryAgent.plist 2>/dev/null');
    exec('launchctl load -w /System/Library/LaunchAgents/com.apple.AMPLibraryAgent.plist 2>/dev/null');

  } catch (err) {
    let errMsg = err.message || 'Unknown error occurred';
    let displayMsg = 'Installation failed!';
    if (errMsg.includes('Operation not permitted') || errMsg.includes('Permission denied')) {
      displayMsg = 'Full Disk Access permission required';
      sendLog('\n[HELP] 🔒 macOS Full Disk Access required!');
      sendLog('[HELP] macOS prevents writing directly to raw disk sectors unless the parent process has Full Disk Access.');
      sendLog('[HELP] To resolve this:');
      sendLog('[HELP] 1. Open macOS System Settings.');
      sendLog('[HELP] 2. Navigate to "Privacy & Security" > "Full Disk Access".');
      sendLog('[HELP] 3. Toggle ON the checkbox for "Terminal" (or whichever terminal/IDE app you used to run this).');
      sendLog('[HELP] 4. Restart this application and try again.\n');
    }
    sendLog(`[FATAL ERROR] ${errMsg}`);
    sendProgress('error', 0, displayMsg);
    
    // Reload agents on failure too
    exec('launchctl load -w /System/Library/LaunchAgents/com.apple.AMPDeviceDiscoveryAgent.plist 2>/dev/null');
    exec('launchctl load -w /System/Library/LaunchAgents/com.apple.AMPLibraryAgent.plist 2>/dev/null');
  }
});

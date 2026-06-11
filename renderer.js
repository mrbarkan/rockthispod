// MacRockPod Installer - Frontend Controller Logic

document.addEventListener('DOMContentLoaded', () => {
  // Elements
  const trackScan = document.getElementById('step-track-scan');
  const trackConfirm = document.getElementById('step-track-confirm');
  const trackInstall = document.getElementById('step-track-install');
  const trackFinish = document.getElementById('step-track-finish');

  const panelScan = document.getElementById('panel-scan');
  const panelConfirm = document.getElementById('panel-confirm');
  const panelInstall = document.getElementById('panel-install');
  const panelFinish = document.getElementById('panel-finish');

  const btnRescan = document.getElementById('btn-rescan');
  const btnNextToConfirm = document.getElementById('btn-next-to-confirm');
  const btnBackToScan = document.getElementById('btn-back-to-scan');
  const btnStartInstall = document.getElementById('btn-start-install');
  const btnCloseApp = document.getElementById('btn-close-app');
  const btnCheckDfu = document.getElementById('btn-check-dfu');

  const deviceListContainer = document.getElementById('device-list-container');
  const modelSelect = document.getElementById('model-select');
  const dfuWarningBox = document.getElementById('dfu-warning-box');
  const dfuStatusBadge = document.getElementById('dfu-status-badge');

  const summaryDiskId = document.getElementById('summary-disk-id');
  const summaryDiskSize = document.getElementById('summary-disk-size');
  const summaryModelName = document.getElementById('summary-model-name');
  const summaryConversionType = document.getElementById('summary-conversion-type');
  const chkSafetyAgree = document.getElementById('chk-safety-agree');

  const installProgressBar = document.getElementById('install-progress-bar');
  const installStatusText = document.getElementById('install-status-text');
  const consoleLogsBody = document.getElementById('console-logs-body');

  const chkStepFreeze = document.getElementById('chk-step-freeze');
  const chkStepPartition = document.getElementById('chk-step-partition');
  const chkStepBootloader = document.getElementById('chk-step-bootloader');
  const chkStepPayload = document.getElementById('chk-step-payload');

  // State Variables
  let devices = [];
  let selectedDevice = null;
  let selectedModel = 'ipodvideo';
  let isDfuDetected = false;

  // Initialize Scan
  checkRootStatus();
  scanDevices();

  async function checkRootStatus() {
    try {
      const isRoot = await window.electronAPI.isRoot();
      const rootBanner = document.getElementById('root-warning-banner');
      if (!isRoot && rootBanner) {
        rootBanner.style.display = 'block';
      }
    } catch (err) {
      console.error('Failed to check root status:', err);
    }
  }

  // Model Selection Change Handler
  modelSelect.addEventListener('change', (e) => {
    selectedModel = e.target.value;
    
    if (selectedModel === 'ipod6g') {
      dfuWarningBox.style.display = 'block';
      checkDfuStatus();
    } else {
      dfuWarningBox.style.display = 'none';
      validateScanCompletion();
    }
  });

  // Check DFU Connection (Classic only)
  btnCheckDfu.addEventListener('click', async () => {
    btnCheckDfu.classList.add('disabled');
    btnCheckDfu.disabled = true;
    dfuStatusBadge.textContent = 'Scanning...';
    dfuStatusBadge.className = 'status-badge';
    
    await checkDfuStatus();
    
    btnCheckDfu.classList.remove('disabled');
    btnCheckDfu.disabled = false;
  });

  async function checkDfuStatus() {
    try {
      const res = await window.electronAPI.scanDfu();
      if (res.found) {
        dfuStatusBadge.textContent = 'DFU Detected';
        dfuStatusBadge.className = 'status-badge success';
        isDfuDetected = true;
      } else {
        dfuStatusBadge.textContent = 'DFU Not Detected';
        dfuStatusBadge.className = 'status-badge error';
        isDfuDetected = false;
      }
    } catch (err) {
      dfuStatusBadge.textContent = 'Scan Error';
      dfuStatusBadge.className = 'status-badge error';
      isDfuDetected = false;
    }
    validateScanCompletion();
  }

  // Scan Devices Function
  async function scanDevices() {
    deviceListContainer.innerHTML = `
      <div class="loading-spinner-container" id="scan-loading">
        <div class="spinner"></div>
        <p>Scanning for connected devices...</p>
      </div>
    `;
    btnRescan.classList.add('disabled');
    btnRescan.disabled = true;
    selectedDevice = null;
    validateScanCompletion();

    try {
      devices = await window.electronAPI.scanIpods();
      deviceListContainer.innerHTML = '';

      if (devices.length === 0) {
        deviceListContainer.innerHTML = `
          <div class="loading-spinner-container">
            <p style="color: var(--text-muted);">No iPod devices detected. Make sure your device is connected and in Disk Mode, then click Rescan.</p>
          </div>
        `;
      } else {
        devices.forEach((dev) => {
          const card = document.createElement('div');
          card.className = 'device-card';
          card.dataset.id = dev.id;
          
          const detailsStr = `${dev.size} • ${dev.volumeName} (${dev.id})`;
          const badgeType = dev.type === 'macpod' ? 'macpod' : 'winpod';
          const badgeText = dev.type === 'macpod' ? 'Mac Format' : 'Windows Format';

          card.innerHTML = `
            <div class="device-info">
              <div class="device-title">${dev.name}</div>
              <div class="device-details">${detailsStr}</div>
            </div>
            <span class="device-badge ${badgeType}">${badgeText}</span>
          `;

          card.addEventListener('click', () => {
            document.querySelectorAll('.device-card').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedDevice = dev;
            validateScanCompletion();
          });

          deviceListContainer.appendChild(card);
        });
      }
    } catch (err) {
      deviceListContainer.innerHTML = `
        <div class="loading-spinner-container">
          <p style="color: #e74c3c;">Error scanning devices: ${err.message}</p>
        </div>
      `;
    }

    btnRescan.classList.remove('disabled');
    btnRescan.disabled = false;
  }

  // Rescan Button Listener
  btnRescan.addEventListener('click', () => {
    scanDevices();
    if (selectedModel === 'ipod6g') {
      checkDfuStatus();
    }
  });

  // Enable/Disable next button based on selection
  function validateScanCompletion() {
    let valid = false;
    
    if (selectedModel === 'ipod6g') {
      // Classic requires either DFU detected OR a disk selected (if they want to do partitioning first)
      valid = isDfuDetected || selectedDevice !== null;
    } else {
      // Video requires a disk selected
      valid = selectedDevice !== null;
    }

    if (valid) {
      btnNextToConfirm.classList.remove('disabled');
      btnNextToConfirm.disabled = false;
    } else {
      btnNextToConfirm.classList.add('disabled');
      btnNextToConfirm.disabled = true;
    }
  }

  // Navigate to Confirmation Screen
  btnNextToConfirm.addEventListener('click', () => {
    panelScan.classList.remove('active');
    panelConfirm.classList.add('active');
    
    trackScan.classList.remove('active');
    trackScan.classList.add('completed');
    trackConfirm.classList.add('active');

    // Populate summary details
    const modelLabel = selectedModel === 'ipod6g' ? 'iPod Classic (6th/7th Gen)' : 'iPod Video (5th/5.5th Gen)';
    
    if (selectedDevice) {
      summaryDiskId.textContent = `/dev/${selectedDevice.id}`;
      summaryDiskSize.textContent = selectedDevice.size;
      summaryModelName.textContent = modelLabel;
      
      if (selectedModel === 'ipod6g') {
        summaryConversionType.textContent = 'MBR FAT32 Native Format (iPod Classic)';
      } else {
        summaryConversionType.textContent = selectedDevice.type === 'macpod' 
          ? 'Convert APM HFS+ to MBR FAT32 (Non-destructive to sectors)'
          : 'FAT32 Struct Detected - Flash Bootloader Only';
      }
    } else if (selectedModel === 'ipod6g' && isDfuDetected) {
      // DFU mode only setup for Classic
      summaryDiskId.textContent = 'DFU Mode Device';
      summaryDiskSize.textContent = 'N/A';
      summaryModelName.textContent = modelLabel;
      summaryConversionType.textContent = 'Flashing DFU Bootstrap Only (No Disk Formatting Required)';
    }

    chkSafetyAgree.checked = false;
    btnStartInstall.classList.add('disabled');
    btnStartInstall.disabled = true;
  });

  // Navigate Back to Scan Screen
  btnBackToScan.addEventListener('click', () => {
    panelConfirm.classList.remove('active');
    panelScan.classList.add('active');
    
    trackConfirm.classList.remove('active');
    trackScan.classList.remove('completed');
    trackScan.classList.add('active');
  });

  // Safety checkbox toggler
  chkSafetyAgree.addEventListener('change', (e) => {
    if (e.target.checked) {
      btnStartInstall.classList.remove('disabled');
      btnStartInstall.disabled = false;
    } else {
      btnStartInstall.classList.add('disabled');
      btnStartInstall.disabled = true;
    }
  });

  // Start Installation Listener
  btnStartInstall.addEventListener('click', () => {
    panelConfirm.classList.remove('active');
    panelInstall.classList.add('active');
    
    trackConfirm.classList.remove('active');
    trackConfirm.classList.add('completed');
    trackInstall.classList.add('active');

    // Reset installation progress elements
    installProgressBar.style.width = '0%';
    installStatusText.textContent = 'Initializing installer configuration...';
    consoleLogsBody.textContent = 'Starting MacRockPod installation routine...\n';

    // Set step indicators to active/pending
    resetStepStates();

    // Trigger backend installation task
    const config = {
      diskId: selectedDevice ? selectedDevice.id : null,
      model: selectedModel,
      isClassic: selectedModel === 'ipod6g'
    };

    window.electronAPI.runInstallTask(config);
  });

  function resetStepStates() {
    const steps = [chkStepFreeze, chkStepPartition, chkStepBootloader, chkStepPayload];
    steps.forEach((s) => {
      s.className = 'check-item pending';
    });
  }

  // Close Application
  btnCloseApp.addEventListener('click', () => {
    window.electronAPI.removeListeners();
    window.close();
  });

  // Listen for logs from main process
  window.electronAPI.onTaskLog((text) => {
    consoleLogsBody.textContent += text + '\n';
    consoleLogsBody.scrollTop = consoleLogsBody.scrollHeight;
  });

  // Listen for progress from main process
  window.electronAPI.onTaskProgress((progress) => {
    const { step, percent, status } = progress;
    
    installProgressBar.style.width = `${percent}%`;
    installStatusText.textContent = status;

    // Manage Checklist Badges
    if (step === 'freeze') {
      chkStepFreeze.className = 'check-item active';
    } else if (step === 'partition') {
      chkStepFreeze.className = 'check-item completed';
      chkStepPartition.className = 'check-item active';
    } else if (step === 'bootloader') {
      chkStepFreeze.className = 'check-item completed';
      chkStepPartition.className = 'check-item completed';
      chkStepBootloader.className = 'check-item active';
    } else if (step === 'payload-download') {
      chkStepFreeze.className = 'check-item completed';
      chkStepPartition.className = 'check-item completed';
      chkStepBootloader.className = 'check-item completed';
      chkStepPayload.className = 'check-item active';
      chkStepPayload.querySelector('.bullet').style.animation = 'pulse 1.5s infinite alternate';
    } else if (step === 'payload-extract') {
      chkStepFreeze.className = 'check-item completed';
      chkStepPartition.className = 'check-item completed';
      chkStepBootloader.className = 'check-item completed';
      chkStepPayload.className = 'check-item active';
    } else if (step === 'complete') {
      chkStepFreeze.className = 'check-item completed';
      chkStepPartition.className = 'check-item completed';
      chkStepBootloader.className = 'check-item completed';
      chkStepPayload.className = 'check-item completed';

      // Small delay for transition satisfaction
      setTimeout(() => {
        panelInstall.classList.remove('active');
        panelFinish.classList.add('active');
        
        trackInstall.classList.remove('active');
        trackInstall.classList.add('completed');
        trackFinish.classList.add('active');
      }, 1500);
    } else if (step === 'error') {
      // Highlight active step in red
      const currentActive = document.querySelector('.check-item.active');
      if (currentActive) {
        currentActive.className = 'check-item failed';
      }
      
      // Let the user go back to try again
      installStatusText.innerHTML = `❌ <span style="color: #e74c3c; font-weight:600;">Error: ${status}</span>`;
      
      // Add a friendly Full Disk Access warning card if permissions are blocked
      let fdaCard = null;
      if (status.toLowerCase().includes('permission') || status.toLowerCase().includes('permitted') || status.toLowerCase().includes('access')) {
        fdaCard = document.createElement('div');
        fdaCard.className = 'glass-card error-border';
        fdaCard.style.marginTop = '20px';
        fdaCard.style.padding = '15px';
        fdaCard.style.textAlign = 'left';
        fdaCard.innerHTML = `
          <h3 style="color: #e74c3c; margin-top: 0; font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
            🔒 macOS Full Disk Access Required
          </h3>
          <p style="font-size: 12.5px; line-height: 1.5; color: var(--text-color); margin-bottom: 10px;">
            macOS security features block writing bootloader sectors to raw storage nodes unless the parent application has explicit Full Disk Access.
          </p>
          <ol style="font-size: 12px; line-height: 1.6; margin-left: 20px; padding-left: 0; color: var(--text-muted);">
            <li>Open macOS <strong>System Settings</strong>.</li>
            <li>Go to <strong>Privacy & Security</strong> &gt; <strong>Full Disk Access</strong>.</li>
            <li>Enable the toggle next to <strong>Terminal</strong> (or the terminal emulator app you used to start this application).</li>
            <li>Restart this application completely.</li>
          </ol>
          <button class="btn primary-btn btn-sm" id="btn-open-fda" style="margin-top: 12px; font-size: 11px; padding: 6px 12px; width: auto;">
            Open Settings Pane
          </button>
        `;
        panelInstall.appendChild(fdaCard);

        const openFdaBtn = fdaCard.querySelector('#btn-open-fda');
        if (openFdaBtn) {
          openFdaBtn.addEventListener('click', () => {
            window.electronAPI.openFdaSettings();
          });
        }
      }

      // Enable backup buttons or close button in place
      const backBtn = document.createElement('button');
      backBtn.className = 'btn secondary-btn';
      backBtn.textContent = 'Back to Setup';
      backBtn.style.marginTop = '15px';
      backBtn.addEventListener('click', () => {
        panelInstall.classList.remove('active');
        panelConfirm.classList.add('active');
        trackInstall.classList.remove('active');
        trackConfirm.classList.add('active');
        if (fdaCard) {
          fdaCard.remove();
        }
        backBtn.remove();
      });
      panelInstall.appendChild(backBtn);
    }
  });
});

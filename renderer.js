// MacRockPod Installer - Frontend Controller Logic (iPod Video 5G / 5.5G)

document.addEventListener('DOMContentLoaded', () => {
  // Track/panel elements
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

  const deviceListContainer = document.getElementById('device-list-container');

  const summaryDiskId = document.getElementById('summary-disk-id');
  const summaryDiskSize = document.getElementById('summary-disk-size');
  const summaryModelName = document.getElementById('summary-model-name');
  const summaryConversionType = document.getElementById('summary-conversion-type');
  const chkSafetyAgree = document.getElementById('chk-safety-agree');

  const installProgressBar = document.getElementById('install-progress-bar');
  const installStatusText = document.getElementById('install-status-text');
  const consoleLogsBody = document.getElementById('console-logs-body');

  // Install steps in execution order. Backend may also emit 'inspect' (folded
  // into 'partition') and 'download'.
  const STEP_SEQUENCE = [
    { name: 'freeze', el: document.getElementById('chk-step-freeze') },
    { name: 'download', el: document.getElementById('chk-step-download') },
    { name: 'partition', el: document.getElementById('chk-step-partition') },
    { name: 'bootloader', el: document.getElementById('chk-step-bootloader') },
    { name: 'payload-extract', el: document.getElementById('chk-step-payload') }
  ];
  // Backend step name -> checklist step name
  const STEP_ALIAS = { inspect: 'partition' };

  // The Rockbox build target is the same id for both iPod Video 5G and 5.5G.
  const TARGET_MODEL = 'ipodvideo';

  let devices = [];
  let selectedDevice = null;

  // Start on the home screen; each flow scans when entered.
  document.body.classList.remove('mode-install');

  async function checkRootStatus() {
    try {
      const isRoot = await window.electronAPI.isRoot();
      const banner = document.getElementById('root-warning-banner');
      if (!isRoot && banner) banner.style.display = 'block';
    } catch (_) { /* non-fatal */ }
  }

  async function scanDevices() {
    deviceListContainer.innerHTML = `
      <div class="loading-spinner-container" id="scan-loading">
        <div class="spinner"></div>
        <p>Scanning for connected devices...</p>
      </div>`;
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
            <p style="color: var(--text-muted);">No iPod detected. Connect your iPod Video in Disk Mode, then click Rescan.</p>
          </div>`;
      } else {
        devices.forEach((dev) => {
          const card = document.createElement('div');
          card.className = 'device-card';
          card.dataset.id = dev.id;

          const badgeType = dev.type === 'macpod' ? 'macpod' : 'winpod';
          const badgeText = dev.type === 'macpod' ? 'Mac Format' : 'Windows Format';

          card.innerHTML = `
            <div class="device-info">
              <div class="device-title">${dev.name}</div>
              <div class="device-details">${dev.size} • ${dev.id}</div>
            </div>
            <span class="device-badge ${badgeType}">${badgeText}</span>`;

          card.addEventListener('click', () => {
            document.querySelectorAll('.device-card').forEach((c) => c.classList.remove('selected'));
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
        </div>`;
    }

    btnRescan.classList.remove('disabled');
    btnRescan.disabled = false;
  }

  btnRescan.addEventListener('click', scanDevices);

  function validateScanCompletion() {
    const valid = selectedDevice !== null;
    btnNextToConfirm.classList.toggle('disabled', !valid);
    btnNextToConfirm.disabled = !valid;
  }

  btnNextToConfirm.addEventListener('click', () => {
    panelScan.classList.remove('active');
    panelConfirm.classList.add('active');
    trackScan.classList.remove('active');
    trackScan.classList.add('completed');
    trackConfirm.classList.add('active');

    if (selectedDevice) {
      summaryDiskId.textContent = `/dev/${selectedDevice.id}`;
      summaryDiskSize.textContent = selectedDevice.size;
      summaryModelName.textContent = 'iPod Video (5th / 5.5th Gen)';
      summaryConversionType.textContent = selectedDevice.type === 'macpod'
        ? 'Convert Mac format (APM) to Windows format (MBR FAT32) — erases all data'
        : 'Rebuild Windows format (MBR FAT32) & install Rockbox — erases all data';
    }

    chkSafetyAgree.checked = false;
    btnStartInstall.classList.add('disabled');
    btnStartInstall.disabled = true;
  });

  btnBackToScan.addEventListener('click', () => {
    panelConfirm.classList.remove('active');
    panelScan.classList.add('active');
    trackConfirm.classList.remove('active');
    trackScan.classList.remove('completed');
    trackScan.classList.add('active');
  });

  chkSafetyAgree.addEventListener('change', (e) => {
    btnStartInstall.classList.toggle('disabled', !e.target.checked);
    btnStartInstall.disabled = !e.target.checked;
  });

  btnStartInstall.addEventListener('click', () => {
    panelConfirm.classList.remove('active');
    panelInstall.classList.add('active');
    trackConfirm.classList.remove('active');
    trackConfirm.classList.add('completed');
    trackInstall.classList.add('active');

    installProgressBar.style.width = '0%';
    installStatusText.textContent = 'Initializing installer...';
    consoleLogsBody.textContent = 'Starting MacRockPod installation...\n';
    resetStepStates();

    window.electronAPI.runInstallTask({
      diskId: selectedDevice ? selectedDevice.id : null,
      model: TARGET_MODEL,
      deviceType: selectedDevice ? selectedDevice.type : null
    });
  });

  function resetStepStates() {
    STEP_SEQUENCE.forEach((s) => { if (s.el) s.el.className = 'check-item pending'; });
  }

  btnCloseApp.addEventListener('click', () => {
    window.electronAPI.removeListeners();
    window.close();
  });

  window.electronAPI.onTaskLog((text) => {
    consoleLogsBody.textContent += text + '\n';
    consoleLogsBody.scrollTop = consoleLogsBody.scrollHeight;
  });

  window.electronAPI.onTaskProgress((progress) => {
    const { step, percent, status } = progress;
    installProgressBar.style.width = `${percent}%`;

    const canonical = STEP_ALIAS[step] || step;
    const idx = STEP_SEQUENCE.findIndex((s) => s.name === canonical);

    if (idx >= 0) {
      STEP_SEQUENCE.forEach((s, i) => {
        if (!s.el) return;
        s.el.className = i < idx ? 'check-item completed'
          : i === idx ? 'check-item active'
          : 'check-item pending';
      });
      installStatusText.textContent = status;
    } else if (step === 'complete') {
      STEP_SEQUENCE.forEach((s) => { if (s.el) s.el.className = 'check-item completed'; });
      installStatusText.textContent = status;
      setTimeout(() => {
        panelInstall.classList.remove('active');
        panelFinish.classList.add('active');
        trackInstall.classList.remove('active');
        trackInstall.classList.add('completed');
        trackFinish.classList.add('active');
      }, 1500);
    } else if (step === 'error') {
      const active = document.querySelector('.check-item.active');
      if (active) active.className = 'check-item failed';
      installStatusText.innerHTML = `❌ <span style="color: #e74c3c; font-weight:600;">${status}</span>`;
      renderErrorHelp(status);
    }
  });

  function renderErrorHelp(status) {
    const lc = status.toLowerCase();
    if (lc.includes('permission') || lc.includes('full disk access') || lc.includes('access')) {
      const card = document.createElement('div');
      card.className = 'glass-card error-border';
      card.style.cssText = 'margin-top:20px;padding:15px;text-align:left;';
      card.innerHTML = `
        <h3 style="color:#e74c3c;margin-top:0;font-size:15px;font-weight:600;">🔒 Full Disk Access Required</h3>
        <p style="font-size:12.5px;line-height:1.5;color:var(--text-color);margin-bottom:10px;">
          macOS blocks raw disk writes unless <strong>MacRockPod</strong> has Full Disk Access.
        </p>
        <ol style="font-size:12px;line-height:1.6;margin-left:20px;color:var(--text-muted);">
          <li>Open System Settings → Privacy &amp; Security → Full Disk Access.</li>
          <li>Turn ON the toggle for <strong>MacRockPod</strong>.</li>
          <li>Quit MacRockPod completely, reopen it, and try again.</li>
        </ol>
        <button class="btn primary-btn btn-sm" id="btn-open-fda" style="margin-top:12px;font-size:11px;padding:6px 12px;width:auto;">Open Settings Pane</button>`;
      panelInstall.appendChild(card);
      const btn = card.querySelector('#btn-open-fda');
      if (btn) btn.addEventListener('click', () => window.electronAPI.openFdaSettings());
    }

    const backBtn = document.createElement('button');
    backBtn.className = 'btn secondary-btn';
    backBtn.textContent = 'Back to Setup';
    backBtn.style.marginTop = '15px';
    backBtn.addEventListener('click', () => {
      panelInstall.classList.remove('active');
      panelConfirm.classList.add('active');
      trackInstall.classList.remove('active');
      trackConfirm.classList.add('active');
      panelInstall.querySelectorAll('.glass-card.error-border, .btn.secondary-btn').forEach((el) => {
        if (el !== backBtn) el.remove();
      });
      backBtn.remove();
    });
    panelInstall.appendChild(backBtn);
  }

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
});

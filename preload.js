const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  scanIpods: () => ipcRenderer.invoke('scan-ipods'),
  runInstallTask: (config) => ipcRenderer.send('run-install-task', config),
  onTaskLog: (callback) => ipcRenderer.on('task-log', (_event, value) => callback(value)),
  onTaskProgress: (callback) => ipcRenderer.on('task-progress', (_event, value) => callback(value)),
  isRoot: () => ipcRenderer.invoke('is-root'),
  openFdaSettings: () => ipcRenderer.send('open-fda-settings'),
  scanRockboxIpods: () => ipcRenderer.invoke('scan-rockbox-ipods'),
  changeLogo: (mountPath, rgbaBuffer) => ipcRenderer.invoke('change-logo', { mountPath, rgba: rgbaBuffer }),
  restoreLogo: (mountPath) => ipcRenderer.invoke('restore-logo', { mountPath }),

  removeListeners: () => {
    ipcRenderer.removeAllListeners('task-log');
    ipcRenderer.removeAllListeners('task-progress');
  }
});

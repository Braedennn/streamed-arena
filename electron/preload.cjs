const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arenaWindow', {
  minimize: () => ipcRenderer.send('arena-window', 'minimize'),
  toggleMaximize: () => ipcRenderer.send('arena-window', 'maximize'),
  close: () => ipcRenderer.send('arena-window', 'close'),
  onState: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on('arena-window-state', wrapped);
    return () => ipcRenderer.removeListener('arena-window-state', wrapped);
  },
});

// Auto-update bridge: the in-app update popup (components/updater/
// UpdatePopup.tsx) uses these to ask for a downloaded release, hear about
// freshly downloaded ones, and trigger the silent install + relaunch.
contextBridge.exposeInMainWorld('arenaUpdater', {
  state: () => ipcRenderer.invoke('arena-updater-state'),
  restart: () => ipcRenderer.send('arena-updater-restart'),
  onUpdate: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('arena-updater-ready', wrapped);
    return () => ipcRenderer.removeListener('arena-updater-ready', wrapped);
  },
});

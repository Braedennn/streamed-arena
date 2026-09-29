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

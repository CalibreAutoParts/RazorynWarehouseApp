// Bridge between the web app and the desktop print agent. The page sees a
// small `window.desktopPrint` API; everything else stays sandboxed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPrint', {
  available: true,
  status: () => ipcRenderer.invoke('agent:status'),
  setEnabled: (on) => ipcRenderer.invoke('agent:set-enabled', !!on),
  listPrinters: () => ipcRenderer.invoke('agent:printers'),
  setPrinter: (name) => ipcRenderer.invoke('agent:set-printer', String(name || '')),
  setStartAtLogin: (on) => ipcRenderer.invoke('agent:set-login', !!on),
  testPrint: () => ipcRenderer.invoke('agent:test'),
  pollNow: () => ipcRenderer.invoke('agent:poll'),
});

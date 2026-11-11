const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  selectFile: (options) => ipcRenderer.invoke('select-file', options),
  saveFile: (options) => ipcRenderer.invoke('save-file', options),
  getServerPort: () => ipcRenderer.invoke('get-server-port'),
  runTool: (toolName, args) => ipcRenderer.invoke('run-tool', toolName, args),
  onToolOutput: (callback) => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('tool-output', listener);
    return () => ipcRenderer.removeListener('tool-output', listener);
  },
  onToolClose: (callback) => {
    const listener = (_event, code) => callback(code);
    ipcRenderer.on('tool-close', listener);
    return () => ipcRenderer.removeListener('tool-close', listener);
  }
});

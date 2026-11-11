const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickAudio: () => ipcRenderer.invoke("pick-audio"),
  transcribe: (path) => ipcRenderer.invoke("transcribe", path),
  cancel: () => ipcRenderer.invoke("cancel"),
  export: (args) => ipcRenderer.invoke("export-transcript", args),
  readSettings: () => ipcRenderer.invoke("read-settings"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
  onEngineLog: (cb) => ipcRenderer.on("engine-log", (_e, text) => cb(text)),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
});

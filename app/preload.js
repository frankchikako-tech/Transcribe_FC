const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  pickAudio: () => ipcRenderer.invoke("pick-audio"),
  transcribe: (path) => ipcRenderer.invoke("transcribe", path),
  cancel: () => ipcRenderer.invoke("cancel"),
  export: (args) => ipcRenderer.invoke("export-transcript", args),
  exportDocx: (args) => ipcRenderer.invoke("export-transcript-docx", args),
  readSettings: () => ipcRenderer.invoke("read-settings"),
  appVersion: () => ipcRenderer.invoke("app-version"),
  saveSettings: (s) => ipcRenderer.invoke("save-settings", s),
  onEngineLog: (cb) => ipcRenderer.on("engine-log", (_e, text) => cb(text)),
  openExternal: (url) => ipcRenderer.invoke("open-external", url),
  checkUpdates: () => ipcRenderer.invoke("check-updates"),
  readAudio: (path) => ipcRenderer.invoke("read-audio", path),
  saveHistory: (item) => ipcRenderer.invoke("save-history", item),
  loadHistory: (id) => ipcRenderer.invoke("load-history", id),
  deleteHistory: (id) => ipcRenderer.invoke("delete-history", id),
});

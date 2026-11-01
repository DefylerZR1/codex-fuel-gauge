const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuelGauge", {
  getSnapshot: () => ipcRenderer.invoke("telemetry:get"),
  refresh: () => ipcRenderer.invoke("telemetry:refresh"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  openUpdate: (url) => ipcRenderer.invoke("update:open", url),
  onUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("telemetry:update", listener);
    return () => ipcRenderer.removeListener("telemetry:update", listener);
  },
  onUpdateResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("update:result", listener);
    return () => ipcRenderer.removeListener("update:result", listener);
  },
});

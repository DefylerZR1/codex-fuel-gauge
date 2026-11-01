const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuelGauge", {
  getSnapshot: () => ipcRenderer.invoke("telemetry:get"),
  refresh: () => ipcRenderer.invoke("telemetry:refresh"),
  onUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("telemetry:update", listener);
    return () => ipcRenderer.removeListener("telemetry:update", listener);
  },
});

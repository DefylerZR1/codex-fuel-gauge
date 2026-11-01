const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("fuelGauge", {
  getSnapshot: () => ipcRenderer.invoke("telemetry:get"),
  refresh: () => ipcRenderer.invoke("telemetry:refresh"),
  checkForUpdates: () => ipcRenderer.invoke("update:check"),
  openUpdate: (url) => ipcRenderer.invoke("update:open", url),
  readRoadmap: () => ipcRenderer.invoke("roadmap:read"),
  getAutomation: () => ipcRenderer.invoke("automation:get"),
  saveAutomation: (settings) => ipcRenderer.invoke("automation:save", settings),
  runAutomation: () => ipcRenderer.invoke("automation:run"),
  getProjects: () => ipcRenderer.invoke("projects:get"),
  scanProjects: () => ipcRenderer.invoke("projects:scan"),
  runProjectAction: (projectId, action) => ipcRenderer.invoke("projects:action", projectId, action),
  setProjectAccess: (projectId, access) => ipcRenderer.invoke("projects:access", projectId, access),
  restoreProject: (projectPath) => ipcRenderer.invoke("projects:restore", projectPath),
  cleanRepository: (projectId) => ipcRenderer.invoke("projects:clean", projectId),
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
  onAutomationUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("automation:update", listener);
    return () => ipcRenderer.removeListener("automation:update", listener);
  },
  onProjectsUpdate: (callback) => {
    const listener = (_event, snapshot) => callback(snapshot);
    ipcRenderer.on("projects:update", listener);
    return () => ipcRenderer.removeListener("projects:update", listener);
  },
});

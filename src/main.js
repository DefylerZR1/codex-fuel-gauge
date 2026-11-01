import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.CODEX_FUEL_GAUGE_PORT || 47831);
const RELEASE_API = "https://api.github.com/repos/DefylerZR1/codex-fuel-gauge/releases/latest";
const RELEASE_URL_PREFIX = "https://github.com/DefylerZR1/codex-fuel-gauge/releases/";
let mainWindow;
let tray;
let apiServer;
let latestSnapshot = { status: { state: "starting", message: "Starting" }, data: null };

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

function broadcast() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("telemetry:update", latestSnapshot);
  }
  updateTray();
}

const client = new AppServerClient({
  onRateLimits(data) {
    latestSnapshot = { ...latestSnapshot, data, status: { state: "connected", message: "Live telemetry connected" } };
    broadcast();
  },
  onStatus(status) {
    latestSnapshot = { ...latestSnapshot, status };
    broadcast();
  },
});

function weeklyBucket() {
  const buckets = latestSnapshot.data?.rateLimitsByLimitId || {};
  const all = Object.values(buckets);
  const week = all.find((bucket) => {
    const windows = [bucket.primary, bucket.secondary].filter(Boolean);
    return windows.some((window) => Number(window.windowDurationMins) >= 6 * 24 * 60);
  });
  return week || latestSnapshot.data?.rateLimits || all[0] || null;
}

function weeklyWindow() {
  const bucket = weeklyBucket();
  if (!bucket) return null;
  return [bucket.primary, bucket.secondary]
    .filter(Boolean)
    .sort((a, b) => Number(b.windowDurationMins || 0) - Number(a.windowDurationMins || 0))[0] || null;
}

function versionParts(version) {
  return String(version).replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate, current) {
  const candidateParts = versionParts(candidate);
  const currentParts = versionParts(current);
  const length = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (candidateParts[index] || 0) - (currentParts[index] || 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

async function checkForUpdates() {
  const response = await fetch(RELEASE_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Codex-Fuel-Gauge" },
  });
  if (!response.ok) throw new Error(`GitHub update check failed (${response.status})`);
  const release = await response.json();
  const currentVersion = app.getVersion();
  const latestVersion = String(release.tag_name || release.name || "").replace(/^v/i, "");
  if (!latestVersion) throw new Error("The latest release did not include a version number");
  return {
    currentVersion,
    latestVersion,
    updateAvailable: isNewerVersion(latestVersion, currentVersion),
    releaseUrl: release.html_url,
  };
}

async function checkForUpdatesFromTray() {
  showWindow();
  try {
    const result = await checkForUpdates();
    mainWindow?.webContents.send("update:result", result);
  } catch (error) {
    mainWindow?.webContents.send("update:result", { error: error.message });
  }
}

function updateTray() {
  if (!tray) return;
  const window = weeklyWindow();
  const remaining = window?.usedPercent == null ? null : Math.max(0, 100 - Number(window.usedPercent));
  const resetLabel = window?.resetsAt ? new Date(window.resetsAt * 1000).toLocaleString() : "Unavailable";
  tray.setToolTip(remaining == null ? "Codex Fuel Gauge" : `Codex Fuel Gauge — ${remaining.toFixed(0)}% remaining`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: remaining == null ? "Usage unavailable" : `${remaining.toFixed(0)}% weekly usage remaining`, enabled: false },
    { label: `Reset: ${resetLabel}`, enabled: false },
    { type: "separator" },
    { label: "Open Fuel Gauge", click: () => showWindow() },
    { label: "Refresh", click: () => client.refresh().catch(() => {}) },
    { label: "Check for updates", click: () => checkForUpdatesFromTray() },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

function makeTrayIcon() {
  const source = nativeImage.createFromPath(path.join(__dirname, "assets", "beowulf-shield.png"));
  return source.resize({ width: 32, height: 32, quality: "best" });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 540,
    minWidth: 640,
    minHeight: 360,
    useContentSize: true,
    backgroundColor: "#07101d",
    title: "Codex Fuel Gauge",
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.setAspectRatio(16 / 9);
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("close", (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function startApi() {
  apiServer = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/api/usage" && req.method === "GET") {
      res.end(JSON.stringify(latestSnapshot, null, 2));
      return;
    }
    if (req.url === "/health" && req.method === "GET") {
      res.end(JSON.stringify({ ok: latestSnapshot.status?.state === "connected" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "Not found" }));
  });
  apiServer.listen(API_PORT, "127.0.0.1");
}

app.on("second-instance", () => showWindow());

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  tray = new Tray(makeTrayIcon());
  tray.on("click", () => showWindow());
  ipcMain.handle("telemetry:get", () => latestSnapshot);
  ipcMain.handle("telemetry:refresh", () => client.refresh());
  ipcMain.handle("update:check", () => checkForUpdates());
  ipcMain.handle("update:open", (_event, url) => {
    if (typeof url !== "string" || !url.startsWith(RELEASE_URL_PREFIX)) throw new Error("Invalid release URL");
    return shell.openExternal(url);
  });
  startApi();
  createWindow();
  await client.start().catch((error) => {
    latestSnapshot = { ...latestSnapshot, status: { state: "error", message: error.message } };
    broadcast();
  });
  setInterval(() => client.refresh().catch(() => {}), 60_000).unref();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  client.stop();
  apiServer?.close();
});

app.on("window-all-closed", () => {});

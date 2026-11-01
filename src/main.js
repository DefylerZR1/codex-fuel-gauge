import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.CODEX_FUEL_GAUGE_PORT || 47831);
let mainWindow;
let tray;
let apiServer;
let latestSnapshot = { status: { state: "starting", message: "Starting" }, data: null };

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

function updateTray() {
  if (!tray) return;
  const window = weeklyWindow();
  const remaining = window?.usedPercent == null ? null : Math.max(0, 100 - Number(window.usedPercent));
  tray.setToolTip(remaining == null ? "Codex Fuel Gauge" : `Codex Fuel Gauge — ${remaining.toFixed(0)}% left`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: remaining == null ? "Usage unavailable" : `${remaining.toFixed(0)}% weekly usage remaining`, enabled: false },
    { label: "Open Fuel Gauge", click: () => showWindow() },
    { label: "Refresh", click: () => client.refresh().catch(() => {}) },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
}

function makeTrayIcon() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#0b1220"/><path d="M6 20h4l3-9 5 14 3-8h5" fill="none" stroke="#35b8ff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`).resize({ width: 16, height: 16 });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 430,
    minHeight: 640,
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

app.whenReady().then(async () => {
  tray = new Tray(makeTrayIcon());
  tray.on("click", () => showWindow());
  ipcMain.handle("telemetry:get", () => latestSnapshot);
  ipcMain.handle("telemetry:refresh", () => client.refresh());
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

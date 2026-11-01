import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import http from "node:http";
import fs from "node:fs/promises";
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
let automationSettings;
let automationTimer;
let automationState = { status: "idle", message: "Automation is idle", history: [] };

const DEFAULT_AUTOMATION_SETTINGS = {
  enabled: false,
  scheduleTime: "12:00",
  dailyTargetPercent: 11,
  reservePercent: 4,
  preResetHours: 12,
  maxRunsPerDay: 3,
  cooldownMinutes: 15,
  mode: "plan",
  projectPath: "",
  objective: "Advance the highest-value unfinished roadmap objective, then tighten and verify the existing project.",
  allowGitPush: false,
  lastCycleDate: null,
  cycleStartUsed: null,
  cycleRuns: 0,
  lastCompletedAt: null,
};

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
  onEvent(message) {
    if (message.method === "turn/completed" && message.params?.turn?.id === automationState.turnId) {
      completeAutomationRun(message.params.turn).catch(() => {});
    }
  },
});

function automationSettingsPath() {
  return path.join(app.getPath("userData"), "automation-settings.json");
}

function broadcastAutomation() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("automation:update", { settings: automationSettings, state: automationState });
  }
}

function sanitizeAutomationSettings(input = {}) {
  const merged = { ...DEFAULT_AUTOMATION_SETTINGS, ...input };
  return {
    ...merged,
    enabled: Boolean(merged.enabled),
    scheduleTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(merged.scheduleTime) ? merged.scheduleTime : "12:00",
    dailyTargetPercent: Math.min(25, Math.max(1, Number(merged.dailyTargetPercent) || 11)),
    reservePercent: Math.min(25, Math.max(0, Number(merged.reservePercent) || 4)),
    preResetHours: Math.min(48, Math.max(0, Number(merged.preResetHours) || 12)),
    maxRunsPerDay: Math.min(10, Math.max(1, Number(merged.maxRunsPerDay) || 3)),
    cooldownMinutes: Math.min(240, Math.max(1, Number(merged.cooldownMinutes) || 15)),
    mode: merged.mode === "autonomous" ? "autonomous" : "plan",
    projectPath: String(merged.projectPath || "").trim(),
    objective: String(merged.objective || DEFAULT_AUTOMATION_SETTINGS.objective).trim(),
    allowGitPush: Boolean(merged.allowGitPush),
  };
}

async function loadAutomationSettings() {
  try {
    automationSettings = sanitizeAutomationSettings(JSON.parse(await fs.readFile(automationSettingsPath(), "utf8")));
  } catch {
    automationSettings = { ...DEFAULT_AUTOMATION_SETTINGS };
  }
  return automationSettings;
}

async function saveAutomationSettings(input) {
  automationSettings = sanitizeAutomationSettings(input);
  await fs.writeFile(automationSettingsPath(), `${JSON.stringify(automationSettings, null, 2)}\n`, "utf8");
  broadcastAutomation();
  return automationSettings;
}

function automationSnapshot() {
  return { settings: automationSettings, state: automationState };
}

function addAutomationHistory(entry) {
  automationState.history = [entry, ...(automationState.history || [])].slice(0, 12);
}

async function validateProjectPath(projectPath) {
  if (!path.isAbsolute(projectPath)) throw new Error("Choose an absolute project folder");
  const stats = await fs.stat(projectPath);
  if (!stats.isDirectory()) throw new Error("The project path is not a folder");
  return path.resolve(projectPath);
}

function buildAutomationPrompt(settings) {
  const modeInstruction = settings.mode === "autonomous"
    ? "Implement the selected work end-to-end, verify it, and leave the repository in a clean, working state."
    : "Audit and plan only. Do not modify files, run destructive commands, commit, push, publish, or change external systems.";
  const gitInstruction = settings.allowGitPush
    ? "You may commit and push completed verified work when the repository instructions authorize it."
    : "Do not push, publish, deploy, send messages, spend money, or change external systems.";
  return `Codex Fuel Gauge scheduled roadmap run.\n\nObjective: ${settings.objective}\n\n${modeInstruction}\n${gitInstruction}\nRead AGENTS.md and project roadmap/documentation first. Preserve unrelated user work. Select one bounded, high-value objective. Prefer correctness, tests, accessibility, performance, documentation, SEO/conversion quality, or reducing known technical debt. Report what you selected, why, what changed, verification performed, remaining risks, and the next recommended objective.`;
}

async function startAutomationRun({ manual = false } = {}) {
  if (automationState.status === "running") throw new Error("An automation run is already active");
  const settings = automationSettings || await loadAutomationSettings();
  const projectPath = await validateProjectPath(settings.projectPath);
  const window = weeklyWindow();
  const used = Number(window?.usedPercent || 0);
  const remaining = 100 - used;
  if (remaining <= settings.reservePercent) throw new Error("The configured usage reserve has been reached");

  const today = new Date().toLocaleDateString("en-CA");
  if (settings.lastCycleDate !== today) {
    settings.lastCycleDate = today;
    settings.cycleStartUsed = used;
    settings.cycleRuns = 0;
  }
  if (!manual && settings.cycleRuns >= settings.maxRunsPerDay) throw new Error("The daily run limit has been reached");

  const sandbox = settings.mode === "autonomous" ? "workspaceWrite" : "readOnly";
  automationState = { ...automationState, status: "starting", message: "Starting Codex roadmap run", startedAt: new Date().toISOString() };
  broadcastAutomation();
  const threadResult = await client.request("thread/start", {
    cwd: projectPath,
    approvalPolicy: "never",
    sandbox,
    serviceName: "codex_fuel_gauge",
  });
  const threadId = threadResult.thread.id;
  const turnResult = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: buildAutomationPrompt(settings) }],
    cwd: projectPath,
    approvalPolicy: "never",
    sandboxPolicy: settings.mode === "autonomous"
      ? { type: "workspaceWrite", writableRoots: [projectPath], networkAccess: false }
      : { type: "readOnly", networkAccess: false },
    effort: "high",
    summary: "concise",
  });
  settings.cycleRuns += 1;
  await saveAutomationSettings(settings);
  automationState = {
    ...automationState,
    status: "running",
    message: `${settings.mode === "autonomous" ? "Autonomous" : "Plan-only"} run ${settings.cycleRuns} is active`,
    threadId,
    turnId: turnResult.turn.id,
  };
  broadcastAutomation();
  return automationSnapshot();
}

async function completeAutomationRun(turn) {
  await client.refresh().catch(() => {});
  const used = Number(weeklyWindow()?.usedPercent || 0);
  const startUsed = Number(automationSettings?.cycleStartUsed ?? used);
  const consumed = Math.max(0, used - startUsed);
  const completedAt = new Date().toISOString();
  automationSettings.lastCompletedAt = completedAt;
  await saveAutomationSettings(automationSettings);
  addAutomationHistory({ completedAt, status: turn.status || "completed", usedPercent: used, cycleConsumedPercent: consumed });
  automationState = {
    ...automationState,
    status: turn.status === "completed" ? "completed" : (turn.status || "completed"),
    message: `Run finished; this cycle has used ${consumed.toFixed(0)}%`,
    completedAt,
  };
  broadcastAutomation();
}

async function evaluateAutomationSchedule() {
  const settings = automationSettings;
  if (!settings?.enabled || automationState.status === "running" || !settings.projectPath) return;
  const now = new Date();
  const today = now.toLocaleDateString("en-CA");
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const [hours, minutes] = settings.scheduleTime.split(":").map(Number);
  const scheduled = minutesNow >= hours * 60 + minutes;
  const resetMs = Number(weeklyWindow()?.resetsAt || 0) * 1000;
  const inPreResetWindow = resetMs > now.getTime() && resetMs - now.getTime() <= settings.preResetHours * 3_600_000;
  if (!scheduled && !inPreResetWindow) return;
  if (settings.lastCycleDate === today && settings.cycleRuns >= settings.maxRunsPerDay) return;
  const used = Number(weeklyWindow()?.usedPercent || 0);
  const cycleStart = settings.lastCycleDate === today ? Number(settings.cycleStartUsed ?? used) : used;
  if (used - cycleStart >= settings.dailyTargetPercent || 100 - used <= settings.reservePercent) return;
  if (settings.lastCompletedAt && now.getTime() - new Date(settings.lastCompletedAt).getTime() < settings.cooldownMinutes * 60_000) return;
  await startAutomationRun().catch((error) => {
    automationState = { ...automationState, status: "error", message: error.message };
    broadcastAutomation();
  });
}

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
  ipcMain.handle("roadmap:read", () => fs.readFile(path.join(__dirname, "..", "ROADMAP.md"), "utf8"));
  ipcMain.handle("automation:get", () => automationSnapshot());
  ipcMain.handle("automation:save", (_event, settings) => saveAutomationSettings(settings));
  ipcMain.handle("automation:run", () => startAutomationRun({ manual: true }));
  await loadAutomationSettings();
  startApi();
  createWindow();
  await client.start().catch((error) => {
    latestSnapshot = { ...latestSnapshot, status: { state: "error", message: error.message } };
    broadcast();
  });
  setInterval(() => client.refresh().catch(() => {}), 60_000).unref();
  automationTimer = setInterval(() => evaluateAutomationSchedule().catch(() => {}), 60_000);
  automationTimer.unref();
});

app.on("before-quit", () => {
  app.isQuitting = true;
  client.stop();
  clearInterval(automationTimer);
  apiServer?.close();
});

app.on("window-all-closed", () => {});

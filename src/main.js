import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from "electron";
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_PORT = Number(process.env.CODEX_FUEL_GAUGE_PORT || 47831);
const RELEASE_API = "https://api.github.com/repos/DefylerZR1/codex-fuel-gauge/releases/latest";
const RELEASE_URL_PREFIX = "https://github.com/DefylerZR1/codex-fuel-gauge/releases/";
const execFileAsync = promisify(execFile);
let mainWindow;
let tray;
let apiServer;
let latestSnapshot = { status: { state: "starting", message: "Starting" }, data: null };
let automationSettings;
let automationTimer;
let automationState = { status: "idle", message: "Automation is idle", history: [] };
let projects = [];
let projectAccessRules = {};
let projectActionState = { status: "idle", message: "Select a project action" };

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
    if (message.method === "turn/completed" && message.params?.turn?.id === projectActionState.turnId) {
      completeProjectAction(message.params.turn).catch(() => {});
    }
  },
});

function automationSettingsPath() {
  return path.join(app.getPath("userData"), "automation-settings.json");
}

function projectsPath() {
  return path.join(app.getPath("userData"), "projects.json");
}

function projectAccessPath() {
  return path.join(app.getPath("userData"), "project-access.json");
}

function broadcastProjects() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("projects:update", projectsSnapshot());
  }
}

async function loadProjects() {
  try { projects = JSON.parse(await fs.readFile(projectsPath(), "utf8")); } catch { projects = []; }
  projects = projects.filter((project) => project.source === "codex" || (project.source === "repository" && project.isGit === true));
  try { projectAccessRules = JSON.parse(await fs.readFile(projectAccessPath(), "utf8")); } catch {
    let legacyIgnored = [];
    try { legacyIgnored = JSON.parse(await fs.readFile(path.join(app.getPath("userData"), "ignored-projects.json"), "utf8")); } catch { /* no legacy exclusions */ }
    projectAccessRules = Object.fromEntries(legacyIgnored.map((entry) => [normalizedProjectPath(entry), "exclude"]));
    await saveProjectAccess();
  }
  projects = projects.filter((project) => projectAccess(project.path) !== "exclude").map((project) => ({ ...project, access: projectAccess(project.path) }));
  return projectsSnapshot();
}

async function saveProjects() {
  await fs.writeFile(projectsPath(), `${JSON.stringify(projects, null, 2)}\n`, "utf8");
  broadcastProjects();
}

async function saveProjectAccess() {
  await fs.writeFile(projectAccessPath(), `${JSON.stringify(projectAccessRules, null, 2)}\n`, "utf8");
}

function projectsSnapshot() {
  return { projects, projectAccessRules, state: projectActionState };
}

function normalizedProjectPath(value) {
  return path.resolve(value).toLowerCase();
}

function projectAccess(projectPath) {
  return projectAccessRules[normalizedProjectPath(projectPath)] || "readWrite";
}

async function repositoryRoot(projectPath) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", projectPath, "rev-parse", "--show-toplevel"], { windowsHide: true, timeout: 5_000 });
    return path.resolve(stdout.trim());
  } catch { return null; }
}

async function projectMetadata(projectPath, threadCount = 0, lastActivity = null, isGit = true, displayName = null, source = "repository") {
  let packageData;
  try { packageData = JSON.parse(await fs.readFile(path.join(projectPath, "package.json"), "utf8")); } catch { packageData = null; }
  const dependencies = { ...(packageData?.dependencies || {}), ...(packageData?.devDependencies || {}) };
  const webMarkers = ["react", "next", "vite", "astro", "@tanstack/react-router", "vue", "svelte", "nuxt"];
  const isWeb = webMarkers.some((name) => name in dependencies)
    || await fs.access(path.join(projectPath, "index.html")).then(() => true).catch(() => false)
    || await fs.access(path.join(projectPath, "public")).then(() => true).catch(() => false);
  let hasRoadmap = false;
  let roadmapFile = null;
  for (const name of ["ROADMAP.md", "PLANS.md", "GOALS.md"]) {
    if (await fs.access(path.join(projectPath, name)).then(() => true).catch(() => false)) { hasRoadmap = true; roadmapFile = name; break; }
  }
  return { id: `${source}:${projectPath.toLowerCase()}`, name: displayName || packageData?.name || path.basename(projectPath), path: projectPath, source, isGit, isWeb, hasRoadmap, threadCount, lastActivity, roadmapFile: hasRoadmap ? roadmapFile : null };
}

async function scanManagedProjects() {
  projectActionState = { status: "scanning", message: "Querying Codex for managed projects and repositories" };
  broadcastProjects();
  const nativeProjects = [];
  let projectCursor = null;
  do {
    const result = await client.request("project/list", { cursor: projectCursor, limit: 100 });
    nativeProjects.push(...(result.data || []));
    projectCursor = result.nextCursor;
  } while (projectCursor);
  const cwdStats = new Map();
  let cursor = null;
  for (let page = 0; page < 5; page += 1) {
    const result = await client.request("thread/list", { cursor, limit: 100, sortKey: "updated_at", sortDirection: "desc", sourceKinds: ["cli", "vscode", "exec", "appServer"] });
    for (const thread of result.data || []) {
      if (!thread.cwd || !path.isAbsolute(thread.cwd)) continue;
      const key = path.resolve(thread.cwd).toLowerCase();
      const current = cwdStats.get(key) || { path: path.resolve(thread.cwd), count: 0, lastActivity: 0 };
      current.count += 1;
      current.lastActivity = Math.max(current.lastActivity, Number(thread.updatedAt || thread.createdAt || 0));
      cwdStats.set(key, current);
    }
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  if (automationSettings?.projectPath) {
    const resolved = path.resolve(automationSettings.projectPath);
    cwdStats.set(resolved.toLowerCase(), cwdStats.get(resolved.toLowerCase()) || { path: resolved, count: 0, lastActivity: 0 });
  }
  const foundPaths = new Map();
  for (const stat of cwdStats.values()) {
    const repository = await repositoryRoot(stat.path);
    if (!repository) continue;
    const projectPath = repository;
    const key = projectPath.toLowerCase();
    const existing = foundPaths.get(key) || { path: projectPath, isGit: Boolean(repository), count: 0, lastActivity: 0 };
    existing.count += stat.count;
    existing.lastActivity = Math.max(existing.lastActivity, stat.lastActivity);
    foundPaths.set(key, existing);
  }
  const nativeEntries = await Promise.all(nativeProjects.flatMap((project) => (project.roots || []).map(async (root) => {
    const repository = await repositoryRoot(root.path);
    return projectMetadata(repository || root.path, 0, project.updatedAt || null, Boolean(repository), project.name, "codex");
  })));
  const repositoryEntries = await Promise.all([...foundPaths.values()].map((item) => projectMetadata(item.path, item.count, item.lastActivity || null, true, null, "repository")));
  const uniqueProjects = new Map();
  for (const entry of [...nativeEntries, ...repositoryEntries]) uniqueProjects.set(entry.id, entry);
  projects = [...uniqueProjects.values()].filter((project) => projectAccess(project.path) !== "exclude").map((project) => ({ ...project, access: projectAccess(project.path) }));
  projects.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0) || a.name.localeCompare(b.name));
  projectActionState = { status: "ready", message: `Found ${projects.length} Codex-managed projects` };
  await saveProjects();
  return projectsSnapshot();
}

async function setProjectAccess(projectId, access) {
  if (!["readWrite", "readOnly", "exclude"].includes(access)) throw new Error("Unsupported folder access mode");
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) throw new Error("Project was not found");
  if (access === "exclude") {
    const result = await dialog.showMessageBox(mainWindow, { type: "question", buttons: ["Cancel", "Exclude folder"], defaultId: 0, cancelId: 0, noLink: true, title: "Exclude project folder", message: `Exclude ${project.name}?`, detail: `${project.path}\n\nFuel Gauge will hide this folder and will not run project tasks in it. You can restore access from Folder access.` });
    if (result.response !== 1) return projectsSnapshot();
  }
  projectAccessRules[normalizedProjectPath(project.path)] = access;
  if (access === "exclude") projects = projects.filter((entry) => entry.id !== projectId);
  else project.access = access;
  await Promise.all([saveProjectAccess(), saveProjects()]);
  return projectsSnapshot();
}

async function restoreExcludedProject(projectPath) {
  projectAccessRules[normalizedProjectPath(projectPath)] = "readWrite";
  await saveProjectAccess();
  return scanManagedProjects();
}

async function cleanRepository(projectId) {
  const project = projects.find((entry) => entry.id === projectId);
  if (!project?.isGit || project.source !== "repository") throw new Error("Only confirmed Git repositories can be cleaned");
  if (projectAccess(project.path) !== "readWrite") throw new Error("Repository cleanup requires Read/Write access");
  const projectRoot = normalizedProjectPath(project.path);
  const runningAppPath = normalizedProjectPath(app.getAppPath());
  if (runningAppPath === projectRoot || runningAppPath.startsWith(`${projectRoot}${path.sep}`)) throw new Error("Fuel Gauge cannot clean the repository it is currently running from");
  if (path.parse(project.path).root === path.resolve(project.path)) throw new Error("Drive roots cannot be cleaned");
  let dirty = [];
  let upstreamSummary = "No upstream branch is configured.";
  try {
    const { stdout } = await execFileAsync("git", ["-C", project.path, "status", "--porcelain"], { windowsHide: true, timeout: 5_000 });
    dirty = stdout.trim().split(/\r?\n/).filter(Boolean);
  } catch { throw new Error("Repository status could not be verified"); }
  try {
    const { stdout } = await execFileAsync("git", ["-C", project.path, "rev-list", "--left-right", "--count", "@{upstream}...HEAD"], { windowsHide: true, timeout: 5_000 });
    const [behind, ahead] = stdout.trim().split(/\s+/).map(Number);
    upstreamSummary = `${ahead || 0} unpushed commit(s); ${behind || 0} commit(s) behind upstream.`;
  } catch { /* display the no-upstream warning */ }
  const detail = `${project.path}\n\nGit status: ${dirty.length ? `${dirty.length} changed or untracked file(s)` : "clean"}\n${upstreamSummary}\n\nThis moves the entire repository to the Windows Recycle Bin. It does not delete the remote repository.`;
  const result = await dialog.showMessageBox(mainWindow, { type: dirty.length ? "warning" : "question", buttons: ["Cancel", "Move to Recycle Bin"], defaultId: 0, cancelId: 0, noLink: true, title: "Clean old repository", message: `Clean ${project.name}?`, detail });
  if (result.response !== 1) return projectsSnapshot();
  await shell.trashItem(project.path);
  projects = projects.filter((entry) => entry.id !== projectId);
  await saveProjects();
  return projectsSnapshot();
}

function projectActionPrompt(action, project) {
  const common = "Read AGENTS.md and existing project documentation first. Preserve unrelated work. Do not push, publish, deploy, message anyone, spend money, or change external systems. Verify every claim and leave a concise result.";
  if (action === "roadmap") return `${common}\n\nInspect this project deeply and create or update ROADMAP.md. Capture the product purpose, current architecture, completed capabilities, known issues, technical debt, security/accessibility/performance concerns, measurable objectives, prioritized milestones, dependencies, acceptance criteria, and the next highest-value tasks. Reconcile existing PLANS.md or GOALS.md instead of duplicating them. The roadmap must be specific to this repository and useful to future Codex automation.`;
  if (action === "seo") return `${common}\n\nPerform a comprehensive technical and on-page SEO audit of this web project. Inspect rendered-route metadata, canonicals, robots directives, sitemap coverage, structured data, headings, internal links, duplicate or thin content, performance risks, accessibility signals, redirects, status behavior, and conversion paths. Write or update SEO_AUDIT.md with evidence, severity, affected routes/files, and prioritized fixes. Do not change production code during this scan.`;
  return `${common}\n\nOptimize this web project for Google Search Console outcomes using available repository evidence and any local GSC exports. Review SEO_AUDIT.md if present, then implement and verify the highest-confidence fixes for indexing, canonicalization, sitemap quality, structured data, content differentiation, internal linking, crawlability, page experience, and search conversion. Do not invent GSC metrics or claim live Search Console access. Document changes and remaining GSC checks in SEO_AUDIT.md.`;
}

async function startProjectAction(projectId, action) {
  if (!["roadmap", "seo", "gsc"].includes(action)) throw new Error("Unsupported project action");
  if (projectActionState.status === "running") throw new Error("Another project action is already running");
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) throw new Error("Select a scanned project first");
  if (projectAccess(project.path) !== "readWrite") throw new Error("This project is Read Only. Change folder access to Read/Write before running project actions.");
  if ((action === "seo" || action === "gsc") && !project.isWeb) throw new Error("SEO actions are available only for detected web projects");
  projectActionState = { status: "starting", message: `Starting ${action} for ${project.name}`, projectId, action };
  broadcastProjects();
  const threadResult = await client.request("thread/start", { cwd: project.path, approvalPolicy: "never", sandbox: "workspaceWrite", serviceName: "codex_fuel_gauge" });
  const turnResult = await client.request("turn/start", {
    threadId: threadResult.thread.id,
    input: [{ type: "text", text: projectActionPrompt(action, project) }],
    cwd: project.path,
    approvalPolicy: "never",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: [project.path], networkAccess: false },
    effort: "high",
    summary: "concise",
  });
  projectActionState = { status: "running", message: `${action === "roadmap" ? "Roadmap assembly" : action === "seo" ? "SEO audit" : "GSC optimization"} is running for ${project.name}`, projectId, action, threadId: threadResult.thread.id, turnId: turnResult.turn.id };
  broadcastProjects();
  return projectsSnapshot();
}

async function completeProjectAction(turn) {
  const project = projects.find((entry) => entry.id === projectActionState.projectId);
  if (project) Object.assign(project, await projectMetadata(project.path, project.threadCount, Math.floor(Date.now() / 1000), project.isGit, project.name, project.source));
  projectActionState = { ...projectActionState, status: turn.status || "completed", message: `${projectActionState.action} finished for ${project?.name || "project"}`, completedAt: new Date().toISOString() };
  await saveProjects();
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
  ipcMain.handle("projects:get", () => projectsSnapshot());
  ipcMain.handle("projects:scan", () => scanManagedProjects());
  ipcMain.handle("projects:action", (_event, projectId, action) => startProjectAction(projectId, action));
  ipcMain.handle("projects:access", (_event, projectId, access) => setProjectAccess(projectId, access));
  ipcMain.handle("projects:restore", (_event, projectPath) => restoreExcludedProject(projectPath));
  ipcMain.handle("projects:clean", (_event, projectId) => cleanRepository(projectId));
  await loadAutomationSettings();
  await loadProjects();
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

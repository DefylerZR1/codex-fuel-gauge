const $ = (selector) => document.querySelector(selector);
const elements = {
  status: $("#status"), gauge: $("#gauge"), remaining: $("#remaining"), used: $("#used"), reset: $("#reset"),
  countdown: $("#countdown"), pace: $("#pace"), plan: $("#plan"), window: $("#window"), updated: $("#updated"),
  message: $("#message"), refresh: $("#refresh"), checkUpdates: $("#check-updates"), roadmapNav: $("#roadmap-nav"),
  roadmapTitle: $("#roadmap-title"), roadmapContent: $("#roadmap-content"), automationForm: $("#automation-form"),
  autoEnabled: $("#auto-enabled"), autoMode: $("#auto-mode"), autoTime: $("#auto-time"), autoTarget: $("#auto-target"),
  autoReserve: $("#auto-reserve"), autoPreReset: $("#auto-prereset"), autoMaxRuns: $("#auto-max-runs"),
  autoCooldown: $("#auto-cooldown"), autoProject: $("#auto-project"), autoObjective: $("#auto-objective"),
  autoPush: $("#auto-push"), autoState: $("#auto-state"), autoMessage: $("#auto-message"), autoRuns: $("#auto-runs"),
  autoCycle: $("#auto-cycle"), autoSave: $("#auto-save"), autoRun: $("#auto-run"),
  scanProjects: $("#scan-projects"), projectCount: $("#project-count"), projectList: $("#project-list"),
  projectsPrev: $("#projects-prev"), projectsNext: $("#projects-next"), projectsPage: $("#projects-page"),
  projectEmpty: $("#project-empty"), projectSelected: $("#project-selected"), projectName: $("#project-name"),
  projectPath: $("#project-path"), projectBadges: $("#project-badges"), projectThreads: $("#project-threads"),
  projectRoadmap: $("#project-roadmap"), projectType: $("#project-type"), projectActionState: $("#project-action-state"),
  projectActionMessage: $("#project-action-message"),
  gitRecommendation: $("#git-recommendation"), openGitGuide: $("#open-git-guide"), gitGuide: $("#git-guide"), closeGitGuide: $("#close-git-guide"),
  ignoredProjects: $("#ignored-projects"), ignoredGuide: $("#ignored-guide"), closeIgnored: $("#close-ignored"), ignoredList: $("#ignored-list"),
  ignoreProject: $("#ignore-project"), cleanRepository: $("#clean-repository"),
};

let latest;
let updateUrl;
let automationSettings;
let automationDirty = false;
let projectSnapshot = { projects: [], state: {} };
let selectedProjectId;
let projectPage = 0;
const PROJECTS_PER_PAGE = 6;
const apiUrl = "http://127.0.0.1:47831/api/usage";

async function getSnapshot() {
  if (window.fuelGauge?.getSnapshot) {
    try { return await window.fuelGauge.getSnapshot(); } catch { /* use API fallback */ }
  }
  const response = await fetch(apiUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Telemetry API returned ${response.status}`);
  return response.json();
}

async function refreshSnapshot() {
  if (window.fuelGauge?.refresh) {
    try { await window.fuelGauge.refresh(); } catch { /* return latest API data */ }
  }
  return getSnapshot();
}

function allBuckets(data) {
  const mapped = Object.values(data?.rateLimitsByLimitId || {});
  return mapped.length ? mapped : data?.rateLimits ? [data.rateLimits] : [];
}

function selectWeekly(data) {
  return allBuckets(data).flatMap((bucket) => [bucket.primary, bucket.secondary].filter(Boolean).map((window) => ({ bucket, window })))
    .sort((a, b) => Number(b.window.windowDurationMins || 0) - Number(a.window.windowDurationMins || 0))[0] || null;
}

function durationLabel(minutes) {
  if (!minutes) return "Unknown";
  if (minutes % 10080 === 0) return `${minutes / 10080} week`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day`;
  if (minutes % 60 === 0) return `${minutes / 60} hour`;
  return `${minutes} min`;
}

function timeRemaining(timestamp) {
  if (!timestamp) return "Unknown";
  const ms = timestamp * 1000 - Date.now();
  if (ms <= 0) return "Resetting";
  const hours = Math.floor(ms / 3_600_000);
  const days = Math.floor(hours / 24);
  return days ? `${days}d ${hours % 24}h` : `${hours}h`;
}

function render(snapshot) {
  latest = snapshot;
  const status = snapshot?.status || { state: "unknown", message: "Status unavailable" };
  elements.status.textContent = status.state === "connected" ? "Live" : status.state;
  elements.status.className = `status ${status.state}`;
  elements.message.textContent = status.message || "";
  const selected = selectWeekly(snapshot?.data);
  if (!selected) return;
  const { bucket, window } = selected;
  const used = Math.min(100, Math.max(0, Number(window.usedPercent || 0)));
  elements.gauge.style.setProperty("--used", String(used));
  elements.remaining.textContent = `${(100 - used).toFixed(0)}%`;
  elements.used.textContent = `${used.toFixed(0)}% used`;
  elements.reset.textContent = window.resetsAt ? `Refills ${new Date(window.resetsAt * 1000).toLocaleString()}` : "Reset time unavailable";
  elements.countdown.textContent = timeRemaining(window.resetsAt);
  elements.window.textContent = durationLabel(window.windowDurationMins);
  elements.plan.textContent = bucket.planType || snapshot?.data?.account?.account?.planType || "ChatGPT";
  elements.updated.textContent = snapshot?.data?.fetchedAt ? new Date(snapshot.data.fetchedAt).toLocaleTimeString() : "—";
  elements.pace.textContent = used / Math.max(1, Number(window.windowDurationMins || 10080) / 1440) >= 10
    ? "On pace for the weekly target" : "Room for additional useful work";
}

function renderUpdateResult(result) {
  elements.checkUpdates.disabled = false;
  if (result?.error) { elements.message.textContent = result.error; elements.checkUpdates.textContent = "Try update check again"; return; }
  if (result?.updateAvailable) {
    updateUrl = result.releaseUrl;
    elements.message.textContent = `Version ${result.latestVersion} is available`;
    elements.checkUpdates.textContent = `Download v${result.latestVersion}`;
    return;
  }
  updateUrl = undefined;
  elements.message.textContent = `Version ${result?.currentVersion || "current"} is up to date`;
  elements.checkUpdates.textContent = "Check for updates";
}

function showView(name) {
  document.querySelectorAll(".view").forEach((view) => view.classList.toggle("active", view.id === `view-${name}`));
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.view === name));
}

function parseRoadmap(markdown) {
  const sections = [];
  let current = { title: "Overview", lines: [] };
  for (const rawLine of markdown.split(/\r?\n/)) {
    if (rawLine.startsWith("## ")) {
      if (current.lines.some((line) => line.trim())) sections.push(current);
      current = { title: rawLine.slice(3).trim(), lines: [] };
    } else if (!rawLine.startsWith("# ")) current.lines.push(rawLine);
  }
  if (current.lines.some((line) => line.trim())) sections.push(current);
  return sections;
}

function renderRoadmapSection(section) {
  elements.roadmapTitle.textContent = section.title;
  elements.roadmapContent.replaceChildren();
  let list;
  for (const rawLine of section.lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("- ") || /^\d+\. /.test(line)) {
      if (!list) { list = document.createElement("ul"); elements.roadmapContent.append(list); }
      const item = document.createElement("li"); item.textContent = line.replace(/^(?:- |\d+\. )/, ""); list.append(item);
    } else {
      list = undefined;
      const paragraph = document.createElement("p"); paragraph.textContent = line; elements.roadmapContent.append(paragraph);
    }
  }
}

async function loadRoadmap() {
  const sections = parseRoadmap(await window.fuelGauge.readRoadmap());
  elements.roadmapNav.replaceChildren();
  sections.forEach((section, index) => {
    const button = document.createElement("button");
    button.type = "button"; button.className = index === 0 ? "active" : ""; button.textContent = section.title;
    button.addEventListener("click", () => {
      elements.roadmapNav.querySelectorAll("button").forEach((entry) => entry.classList.toggle("active", entry === button));
      renderRoadmapSection(section);
    });
    elements.roadmapNav.append(button);
  });
  if (sections[0]) renderRoadmapSection(sections[0]);
}

function fillAutomationForm(settings) {
  automationSettings = settings;
  elements.autoEnabled.checked = settings.enabled;
  elements.autoMode.value = settings.mode;
  elements.autoTime.value = settings.scheduleTime;
  elements.autoTarget.value = settings.dailyTargetPercent;
  elements.autoReserve.value = settings.reservePercent;
  elements.autoPreReset.value = settings.preResetHours;
  elements.autoMaxRuns.value = settings.maxRunsPerDay;
  elements.autoCooldown.value = settings.cooldownMinutes;
  elements.autoProject.value = settings.projectPath;
  elements.autoObjective.value = settings.objective;
  elements.autoPush.checked = settings.allowGitPush;
  automationDirty = false;
}

function collectAutomationForm() {
  return { ...automationSettings, enabled: elements.autoEnabled.checked, mode: elements.autoMode.value, scheduleTime: elements.autoTime.value,
    dailyTargetPercent: Number(elements.autoTarget.value), reservePercent: Number(elements.autoReserve.value), preResetHours: Number(elements.autoPreReset.value),
    maxRunsPerDay: Number(elements.autoMaxRuns.value), cooldownMinutes: Number(elements.autoCooldown.value), projectPath: elements.autoProject.value,
    objective: elements.autoObjective.value, allowGitPush: elements.autoPush.checked };
}

function renderAutomation(snapshot) {
  if (!snapshot) return;
  if (!automationDirty && snapshot.settings) fillAutomationForm(snapshot.settings);
  const state = snapshot.state || {};
  elements.autoState.textContent = state.status || "idle";
  elements.autoMessage.textContent = state.message || "Automation is idle";
  elements.autoRuns.textContent = `${snapshot.settings?.cycleRuns || 0} runs`;
  const consumed = Math.max(0, Number(latest ? selectWeekly(latest.data)?.window?.usedPercent || 0 : 0) - Number(snapshot.settings?.cycleStartUsed || 0));
  elements.autoCycle.textContent = snapshot.settings?.lastCycleDate ? `${consumed.toFixed(0)}% consumed this cycle` : "No cycle started";
  elements.autoRun.disabled = state.status === "running" || state.status === "starting";
}

function selectedProject() { return projectSnapshot.projects.find((project) => project.id === selectedProjectId); }

function renderProjectDetail() {
  const project = selectedProject();
  elements.projectEmpty.hidden = Boolean(project);
  elements.projectSelected.hidden = !project;
  if (!project) return;
  elements.projectName.textContent = project.name;
  elements.projectPath.textContent = project.path;
  elements.projectPath.title = project.path;
  elements.projectThreads.textContent = String(project.threadCount || 0);
  elements.projectRoadmap.textContent = project.roadmapFile || "Missing";
  elements.projectType.textContent = project.isWeb ? "Web project" : "Project";
  elements.gitRecommendation.hidden = project.isGit !== false;
  elements.cleanRepository.disabled = !(project.isGit && project.source === "repository");
  elements.cleanRepository.title = elements.cleanRepository.disabled ? "Only confirmed Git repositories can be cleaned" : "Move this local repository to the Recycle Bin";
  elements.projectBadges.replaceChildren();
  for (const label of [project.source === "codex" ? "Codex project" : "Repository", project.isGit === false ? "No Git" : "Git", project.isWeb ? "Web" : "Local", project.roadmapFile ? "Roadmap" : "Needs roadmap"]) {
    const badge = document.createElement("span"); badge.textContent = label; elements.projectBadges.append(badge);
  }
  document.querySelectorAll("[data-project-action]").forEach((button) => {
    const requiresWeb = button.dataset.projectAction !== "roadmap";
    button.disabled = projectSnapshot.state?.status === "running" || (requiresWeb && !project.isWeb);
    button.title = requiresWeb && !project.isWeb ? "SEO actions are available for detected web projects" : "";
  });
}

function renderProjects(snapshot) {
  if (snapshot) projectSnapshot = snapshot;
  const projects = projectSnapshot.projects || [];
  const pageCount = Math.max(1, Math.ceil(projects.length / PROJECTS_PER_PAGE));
  projectPage = Math.min(projectPage, pageCount - 1);
  if (!projects.some((project) => project.id === selectedProjectId)) selectedProjectId = projects[0]?.id;
  elements.projectCount.textContent = `${projects.length} managed project${projects.length === 1 ? "" : "s"}`;
  elements.ignoredProjects.textContent = `Ignored (${projectSnapshot.ignoredProjectPaths?.length || 0})`;
  elements.projectList.replaceChildren();
  const pageProjects = projects.slice(projectPage * PROJECTS_PER_PAGE, (projectPage + 1) * PROJECTS_PER_PAGE);
  if (!pageProjects.length) {
    const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "Query Codex for its managed projects and local repository paths."; elements.projectList.append(empty);
  }
  for (const project of pageProjects) {
    const button = document.createElement("button"); button.type = "button"; button.className = `project-item${project.id === selectedProjectId ? " active" : ""}`;
    const name = document.createElement("strong"); name.textContent = project.name;
    const path = document.createElement("small"); path.textContent = project.path; button.append(name, path);
    button.addEventListener("click", () => { selectedProjectId = project.id; renderProjects(); });
    elements.projectList.append(button);
  }
  elements.projectsPage.textContent = `Page ${projectPage + 1} of ${pageCount}`;
  elements.projectsPrev.disabled = projectPage === 0;
  elements.projectsNext.disabled = projectPage >= pageCount - 1;
  const state = projectSnapshot.state || {};
  elements.projectActionState.textContent = state.status || "Idle";
  elements.projectActionMessage.textContent = state.message || "Select an action to begin.";
  elements.scanProjects.disabled = state.status === "scanning" || state.status === "running";
  elements.scanProjects.textContent = state.status === "scanning" ? "Scanning..." : "Scan projects";
  renderProjectDetail();
}

document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => showView(tab.dataset.view)));
elements.automationForm.addEventListener("input", () => { automationDirty = true; });
elements.refresh.addEventListener("click", async () => {
  elements.refresh.disabled = true; elements.refresh.textContent = "Refreshing…";
  try { render(await refreshSnapshot()); } finally { elements.refresh.disabled = false; elements.refresh.textContent = "Refresh telemetry"; }
});
elements.checkUpdates.addEventListener("click", async () => {
  if (updateUrl) { await window.fuelGauge.openUpdate(updateUrl); return; }
  elements.checkUpdates.disabled = true; elements.checkUpdates.textContent = "Checking…"; elements.message.textContent = "Checking GitHub for the latest release";
  try { renderUpdateResult(await window.fuelGauge.checkForUpdates()); } catch (error) { renderUpdateResult({ error: error.message }); }
});
elements.autoSave.addEventListener("click", async () => {
  elements.autoSave.disabled = true;
  try { fillAutomationForm(await window.fuelGauge.saveAutomation(collectAutomationForm())); elements.autoMessage.textContent = "Configuration saved"; }
  catch (error) { elements.autoMessage.textContent = error.message; }
  finally { elements.autoSave.disabled = false; }
});
elements.autoRun.addEventListener("click", async () => {
  elements.autoRun.disabled = true;
  try { await window.fuelGauge.saveAutomation(collectAutomationForm()); renderAutomation(await window.fuelGauge.runAutomation()); }
  catch (error) { elements.autoMessage.textContent = error.message; elements.autoRun.disabled = false; }
});
elements.scanProjects.addEventListener("click", async () => {
  elements.scanProjects.disabled = true; elements.scanProjects.textContent = "Scanning...";
  try { renderProjects(await window.fuelGauge.scanProjects()); }
  catch (error) { elements.projectActionMessage.textContent = error.message; elements.scanProjects.disabled = false; elements.scanProjects.textContent = "Scan projects"; }
});
elements.projectsPrev.addEventListener("click", () => { projectPage = Math.max(0, projectPage - 1); renderProjects(); });
elements.projectsNext.addEventListener("click", () => { projectPage += 1; renderProjects(); });
document.querySelectorAll("[data-project-action]").forEach((button) => button.addEventListener("click", async () => {
  if (!selectedProjectId) return;
  try { renderProjects(await window.fuelGauge.runProjectAction(selectedProjectId, button.dataset.projectAction)); }
  catch (error) { elements.projectActionMessage.textContent = error.message; }
}));
elements.openGitGuide.addEventListener("click", () => elements.gitGuide.showModal());
elements.closeGitGuide.addEventListener("click", () => elements.gitGuide.close());
elements.ignoreProject.addEventListener("click", async () => {
  if (!selectedProjectId) return;
  const projectId = selectedProjectId;
  try { selectedProjectId = undefined; renderProjects(await window.fuelGauge.ignoreProject(projectId)); }
  catch (error) { elements.projectActionMessage.textContent = error.message; }
});
elements.cleanRepository.addEventListener("click", async () => {
  if (!selectedProjectId) return;
  const projectId = selectedProjectId;
  try { selectedProjectId = undefined; renderProjects(await window.fuelGauge.cleanRepository(projectId)); }
  catch (error) { elements.projectActionMessage.textContent = error.message; }
});
function renderIgnoredProjects() {
  elements.ignoredList.replaceChildren();
  for (const projectPath of projectSnapshot.ignoredProjectPaths || []) {
    const row = document.createElement("div"); row.className = "ignored-item";
    const label = document.createElement("span"); label.textContent = projectPath; label.title = projectPath;
    const restore = document.createElement("button"); restore.type = "button"; restore.className = "secondary"; restore.textContent = "Use again";
    restore.addEventListener("click", async () => { renderProjects(await window.fuelGauge.restoreProject(projectPath)); renderIgnoredProjects(); });
    row.append(label, restore); elements.ignoredList.append(row);
  }
  if (!elements.ignoredList.children.length) { const empty = document.createElement("p"); empty.className = "empty-state"; empty.textContent = "No folders are currently ignored."; elements.ignoredList.append(empty); }
}
elements.ignoredProjects.addEventListener("click", () => { renderIgnoredProjects(); elements.ignoredGuide.showModal(); });
elements.closeIgnored.addEventListener("click", () => elements.ignoredGuide.close());

if (window.fuelGauge?.onUpdate) window.fuelGauge.onUpdate(render);
if (window.fuelGauge?.onUpdateResult) window.fuelGauge.onUpdateResult(renderUpdateResult);
if (window.fuelGauge?.onAutomationUpdate) window.fuelGauge.onAutomationUpdate(renderAutomation);
if (window.fuelGauge?.onProjectsUpdate) window.fuelGauge.onProjectsUpdate(renderProjects);
Promise.all([getSnapshot(), window.fuelGauge.getAutomation(), window.fuelGauge.getProjects(), loadRoadmap()]).then(([snapshot, automation, projects]) => { render(snapshot); renderAutomation(automation); renderProjects(projects); })
  .catch((error) => { elements.status.textContent = "Offline"; elements.status.className = "status error"; elements.message.textContent = error.message; });
setInterval(() => getSnapshot().then(render).catch(() => {}), 15_000);
setInterval(() => latest && render(latest), 30_000);

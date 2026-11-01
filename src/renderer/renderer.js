const elements = {
  status: document.querySelector("#status"),
  gauge: document.querySelector("#gauge"),
  remaining: document.querySelector("#remaining"),
  used: document.querySelector("#used"),
  reset: document.querySelector("#reset"),
  countdown: document.querySelector("#countdown"),
  pace: document.querySelector("#pace"),
  plan: document.querySelector("#plan"),
  window: document.querySelector("#window"),
  updated: document.querySelector("#updated"),
  message: document.querySelector("#message"),
  refresh: document.querySelector("#refresh"),
};

let latest;
const apiUrl = "http://127.0.0.1:47831/api/usage";

async function getSnapshot() {
  if (window.fuelGauge?.getSnapshot) {
    try {
      return await window.fuelGauge.getSnapshot();
    } catch {
      // Fall through to the localhost API if the Electron bridge is unavailable.
    }
  }
  const response = await fetch(apiUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Telemetry API returned ${response.status}`);
  return response.json();
}

async function refreshSnapshot() {
  if (window.fuelGauge?.refresh) {
    try {
      await window.fuelGauge.refresh();
    } catch {
      // The API read below will still return the latest good snapshot.
    }
  }
  return getSnapshot();
}

function allBuckets(data) {
  const mapped = Object.values(data?.rateLimitsByLimitId || {});
  return mapped.length ? mapped : data?.rateLimits ? [data.rateLimits] : [];
}

function selectWeekly(data) {
  const candidates = allBuckets(data).flatMap((bucket) =>
    [bucket.primary, bucket.secondary]
      .filter(Boolean)
      .map((window) => ({ bucket, window })),
  );
  return candidates.sort((a, b) => Number(b.window.windowDurationMins || 0) - Number(a.window.windowDurationMins || 0))[0] || null;
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
  const remaining = 100 - used;
  elements.gauge.style.setProperty("--used", String(used));
  elements.remaining.textContent = `${remaining.toFixed(0)}%`;
  elements.used.textContent = `${used.toFixed(0)}% used`;
  elements.reset.textContent = window.resetsAt
    ? `Refills ${new Date(window.resetsAt * 1000).toLocaleString()}`
    : "Reset time unavailable";
  elements.countdown.textContent = timeRemaining(window.resetsAt);
  elements.window.textContent = durationLabel(window.windowDurationMins);
  elements.plan.textContent = bucket.planType || snapshot?.data?.account?.account?.planType || "ChatGPT";
  elements.updated.textContent = snapshot?.data?.fetchedAt
    ? new Date(snapshot.data.fetchedAt).toLocaleTimeString()
    : "—";

  const cycleDays = Math.max(1, Number(window.windowDurationMins || 10080) / 1440);
  const dailyAverage = used / cycleDays;
  elements.pace.textContent = dailyAverage >= 10
    ? "On pace for the weekly target"
    : "Room for additional useful work";
}

elements.refresh.addEventListener("click", async () => {
  elements.refresh.disabled = true;
  elements.refresh.textContent = "Refreshing…";
  try {
    render(await refreshSnapshot());
  } finally {
    elements.refresh.disabled = false;
    elements.refresh.textContent = "Refresh telemetry";
  }
});

if (window.fuelGauge?.onUpdate) window.fuelGauge.onUpdate(render);
getSnapshot().then(render).catch((error) => {
  elements.status.textContent = "Offline";
  elements.status.className = "status error";
  elements.message.textContent = error.message;
});
setInterval(() => getSnapshot().then(render).catch(() => {}), 15_000);
setInterval(() => latest && render(latest), 30_000);

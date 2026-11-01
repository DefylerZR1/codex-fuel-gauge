import { spawn } from "node:child_process";
import readline from "node:readline";

const CLIENT_INFO = {
  name: "codex_fuel_gauge",
  title: "Codex Fuel Gauge",
  version: "0.1.0",
};

export class AppServerClient {
  constructor({ onRateLimits, onStatus, onEvent } = {}) {
    this.onRateLimits = onRateLimits ?? (() => {});
    this.onStatus = onStatus ?? (() => {});
    this.onEvent = onEvent ?? (() => {});
    this.pending = new Map();
    this.nextId = 1;
    this.proc = null;
    this.rl = null;
    this.reconnectTimer = null;
    this.stopping = false;
  }

  async start() {
    if (this.proc) return;
    this.stopping = false;
    this.onStatus({ state: "connecting", message: "Connecting to Codex App Server" });

    const executable = process.env.CODEX_EXECUTABLE || "codex";
    this.proc = spawn(executable, ["app-server"], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    this.proc.once("error", (error) => this.handleDisconnect(error));
    this.proc.once("exit", (code, signal) => {
      if (!this.stopping) {
        this.handleDisconnect(new Error(`Codex App Server exited (${code ?? signal ?? "unknown"})`));
      }
    });
    this.proc.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.onStatus({ state: "warning", message });
    });

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.request("initialize", { clientInfo: CLIENT_INFO });
    this.notify("initialized", {});
    this.onStatus({ state: "connected", message: "Live telemetry connected" });
    await this.refresh();
  }

  async refresh() {
    const [limits, usage, account] = await Promise.all([
      this.request("account/rateLimits/read"),
      this.request("account/usage/read").catch(() => null),
      this.request("account/read", { refreshToken: false }).catch(() => null),
    ]);
    const payload = {
      fetchedAt: new Date().toISOString(),
      ...limits,
      usage,
      account,
    };
    this.onRateLimits(payload);
    return payload;
  }

  request(method, params) {
    if (!this.proc?.stdin?.writable) {
      return Promise.reject(new Error("Codex App Server is not connected"));
    }
    const id = this.nextId++;
    const message = { method, id };
    if (params !== undefined) message.params = params;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 15_000);
      this.pending.set(id, { resolve, reject, timeout });
      this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  notify(method, params) {
    if (this.proc?.stdin?.writable) {
      this.proc.stdin.write(`${JSON.stringify({ method, params })}\n`);
    }
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || "App Server request failed"));
      else pending.resolve(message.result);
      return;
    }

    this.onEvent(message);

    if (message.method === "account/rateLimits/updated") {
      this.refresh().catch((error) => {
        this.onStatus({ state: "warning", message: error.message });
      });
    }
  }

  handleDisconnect(error) {
    if (this.stopping) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.rl?.close();
    this.rl = null;
    this.proc = null;
    this.onStatus({ state: "disconnected", message: error.message });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start().catch(() => {}), 10_000);
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.reconnectTimer);
    this.rl?.close();
    this.proc?.kill();
    this.proc = null;
  }
}

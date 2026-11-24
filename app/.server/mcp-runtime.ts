import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { query } from "./db";

const SETTING_KEY = "mcp_http_enabled";

function rootDir(): string {
  return process.env.UNIROUTE_ROOT ?? process.cwd();
}

function mcpHttpPort(): number {
  const n = Number(process.env.UNIROUTE_MCP_PORT ?? 3007);
  return Number.isFinite(n) && n > 0 ? n : 3007;
}

function isMcpHttpTokenSet(): boolean {
  return Boolean(process.env.UNIROUTE_MCP_TOKEN?.trim());
}

function isMcpHttpEnabledSetting(): boolean {
  const row = query("SELECT value FROM settings WHERE key = ?").get(SETTING_KEY) as
    | { value?: string }
    | undefined;
  return row?.value === "1";
}

function setMcpHttpEnabledSetting(enabled: boolean): void {
  query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(SETTING_KEY, enabled ? "1" : "0");
}

const state: {
  proc: ChildProcess | null;
  pid: number | null;
  startedAt: number | null;
  lastError: string | null;
} = {
  proc: null,
  pid: null,
  startedAt: null,
  lastError: null,
};

function isRunning(): boolean {
  return state.proc !== null;
}

export function mcpHttpStatus() {
  return {
    running: isRunning(),
    pid: state.pid,
    port: mcpHttpPort(),
    startedAt: state.startedAt,
    enabled: isMcpHttpEnabledSetting(),
    tokenSet: isMcpHttpTokenSet(),
    lastError: state.lastError,
  };
}

export function startMcpHttp(): { ok: boolean; message?: string; pid?: number } {
  if (isRunning()) {
    return { ok: true, message: "already running", pid: state.pid ?? undefined };
  }
  setMcpHttpEnabledSetting(true);
  const port = mcpHttpPort();
  const cmd = ["bun", path.join(rootDir(), "app", ".server", "mcp-server.ts")];
  const proc = spawn(cmd[0], [...cmd.slice(1), "--http", String(port)], {
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  state.proc = proc;
  state.pid = proc.pid ?? null;
  state.startedAt = Date.now();
  state.lastError = null;
  let stderrBuf = "";
  proc.stderr?.on("data", (chunk: Buffer | string) => {
    stderrBuf += chunk.toString();
    if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    state.lastError = stderrBuf.trim().slice(-500) || null;
  });
  proc.on("exit", (code) => {
    if (state.proc === proc) {
      state.lastError =
        code === 0 || code === null ? state.lastError : `exited with code ${code}`;
      state.proc = null;
      state.pid = null;
      state.startedAt = null;
    }
  });
  proc.on("error", (err) => {
    if (state.proc === proc) {
      state.lastError = err.message;
      state.proc = null;
      state.pid = null;
      state.startedAt = null;
    }
  });
  return { ok: true, pid: proc.pid ?? undefined };
}

export function stopMcpHttp(): { ok: boolean; message?: string } {
  setMcpHttpEnabledSetting(false);
  if (!isRunning()) {
    return { ok: true, message: "not running" };
  }
  try {
    state.proc?.kill();
  } catch {
    // ignore
  }
  state.proc = null;
  state.pid = null;
  state.startedAt = null;
  return { ok: true };
}

export function ensureMcpHttpFromSettings(): void {
  // Remote MCP HTTP is served directly on `/api/mcp` inside the main UniRoute server.
  // Only spawn the legacy standalone port 3007 daemon if explicitly requested via env.
  if (
    process.env.UNIROUTE_MCP_STANDALONE === "1" &&
    isMcpHttpEnabledSetting() &&
    !isRunning()
  ) {
    startMcpHttp();
  }
}

export function killMcpHttpProcess(): void {
  if (!isRunning()) return;
  try {
    state.proc?.kill();
  } catch {
    // ignore
  }
  state.proc = null;
  state.pid = null;
  state.startedAt = null;
}

import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEFAULT_TUNNEL_SETTINGS,
  VALID_TUNNEL_PROVIDERS,
  type CloudflaredMode,
  type CloudflaredProtocol,
  type FrpcProtocol,
  type NgrokRegion,
  type PublicTunnelSettings,
  type TunnelLogEntry,
  type TunnelProviderId,
  type TunnelRuntimeStatus,
  type TunnelSettings,
  type TunnelStateStatus,
} from "../lib/tunnel-options";
import { query } from "./db";
import { isLoopbackHost } from "./ssrf";
import { resolveTunnelBinary } from "./tunnel-tools";

const SETTINGS_KEY = "tunnel_settings";
const MAX_LOG_LINES = 80;
const RECONNECT_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000];

const VALID_CF_MODES = new Set<CloudflaredMode>(["quick", "token"]);
const VALID_CF_PROTOCOLS = new Set<CloudflaredProtocol>(["auto", "http2", "quic"]);
const VALID_NGROK_REGIONS = new Set<NgrokRegion>([
  "auto",
  "us",
  "eu",
  "ap",
  "au",
  "sa",
  "jp",
  "in",
]);
const VALID_FRPC_PROTOCOLS = new Set<FrpcProtocol>(["http", "https"]);

export type TunnelSettingsPatch = Partial<TunnelSettings> & {
  clear_cloudflared_token?: boolean;
  clear_ngrok_authtoken?: boolean;
  clear_frpc_token?: boolean;
  clear_bore_secret?: boolean;
};

export type TunnelSpawnSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  expectedPublicUrl: string | null;
  configPath?: string;
};

export type ParsedTunnelOutput = {
  publicUrl?: string;
  connected?: boolean;
  error?: string;
  fatal?: boolean;
};

type TunnelRuntimeInternal = {
  child: ChildProcess | null;
  status: TunnelStateStatus;
  provider: TunnelProviderId;
  publicUrl: string | null;
  localTarget: string | null;
  pid: number | null;
  startedAt: number | null;
  reconnectAttempts: number;
  lastError: string | null;
  logs: TunnelLogEntry[];
  manualStop: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  serverPort: number | null;
  generation: number;
};

const RUNTIME_SYMBOL = Symbol.for("uniroute.tunnelRuntime");

// Keep runtime state on globalThis so Vite HMR reloads do not orphan child processes.
function getRuntime(): TunnelRuntimeInternal {
  const g = globalThis as Record<symbol, TunnelRuntimeInternal | undefined>;
  if (!g[RUNTIME_SYMBOL]) {
    g[RUNTIME_SYMBOL] = {
      child: null,
      status: "stopped",
      provider: "cloudflared",
      publicUrl: null,
      localTarget: null,
      pid: null,
      startedAt: null,
      reconnectAttempts: 0,
      lastError: null,
      logs: [],
      manualStop: false,
      reconnectTimer: null,
      serverPort: null,
      generation: 0,
    };
  }
  return g[RUNTIME_SYMBOL]!;
}

export function normalizeDomain(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^https?:\/\//i, "");
  s = s.split(/[/?#]/)[0] ?? "";
  s = s.replace(/\.+$/, "");
  if (!s) return "";
  if (s.length > 253 || !s.includes(".")) {
    throw new Error(`Invalid domain "${raw.trim()}": expected a hostname like ai.example.com.`);
  }
  const labels = s.split(".");
  for (const label of labels) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
      throw new Error(`Invalid domain "${raw.trim()}": invalid hostname label "${label}".`);
    }
  }
  return s;
}

export function normalizeLocalHost(raw: string): string {
  let s = raw.trim();
  if (!s) return "127.0.0.1";
  if (s.startsWith("[") && s.endsWith("]")) {
    s = s.slice(1, -1).trim();
  }
  if (!s) return "127.0.0.1";
  if (!/^[a-zA-Z0-9._:-]+$/.test(s)) {
    throw new Error(`Invalid local host "${s}".`);
  }
  if (
    !isLoopbackHost(s) &&
    process.env.UNIROUTE_ALLOW_NONLOOPBACK_TUNNEL !== "1"
  ) {
    throw new Error(`Local host "${s}" must be a loopback address.`);
  }
  return s;
}

export function formatHostPort(host: string, port: number): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function canConnectTcp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// Vite binds to [::1] only on Windows by default; probe loopback siblings to prevent 502s.
export async function resolveReachableLocalHost(
  configuredHost: string,
  port: number,
  timeoutMs = 400,
): Promise<string> {
  const host = normalizeLocalHost(configuredHost);
  let candidates: string[] | null = null;
  if (host === "127.0.0.1") candidates = ["127.0.0.1", "::1"];
  else if (host === "::1") candidates = ["::1", "127.0.0.1"];
  else if (host.toLowerCase() === "localhost") candidates = ["127.0.0.1", "::1"];

  if (!candidates) return host;
  const results = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      ok: await canConnectTcp(candidate, port, timeoutMs),
    })),
  );
  const hit = results.find((r) => r.ok);
  return hit ? hit.candidate : host;
}

function normalizeHostToken(raw: string, fieldLabel: string): string {
  const s = raw.trim();
  if (!s) return "";
  if (!/^[a-zA-Z0-9.-]+$/.test(s)) {
    throw new Error(`Invalid ${fieldLabel}: "${s}".`);
  }
  return s;
}

export function scrubSecrets(line: string, secrets: string[]): string {
  let out = line;
  for (const sec of secrets) {
    if (sec && sec.length > 0) {
      out = out.split(sec).join("[redacted]");
    }
  }
  return out;
}

function tunnelsConfigDir(overrideDir?: string): string {
  if (overrideDir) return overrideDir;
  return (
    process.env.UNIROUTE_TUNNELS_DIR?.trim() ||
    path.join(homedir(), ".uniroute", "tunnels")
  );
}

function clampPort(value: unknown, fallback: number, allowZero: boolean): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.trunc(n);
  if (allowZero && rounded === 0) return 0;
  if (rounded < 1 || rounded > 65535) return fallback;
  return rounded;
}

export function getTunnelSettings(): TunnelSettings {
  const row = query("SELECT value FROM settings WHERE key = ?").get(SETTINGS_KEY) as
    | { value?: string }
    | undefined;
  if (!row?.value) {
    return { ...DEFAULT_TUNNEL_SETTINGS };
  }
  try {
    const parsed = JSON.parse(row.value) as Partial<TunnelSettings>;
    return {
      ...DEFAULT_TUNNEL_SETTINGS,
      ...parsed,
      provider: VALID_TUNNEL_PROVIDERS.has(parsed.provider as TunnelProviderId)
        ? (parsed.provider as TunnelProviderId)
        : DEFAULT_TUNNEL_SETTINGS.provider,
    };
  } catch {
    return { ...DEFAULT_TUNNEL_SETTINGS };
  }
}

export function getPublicTunnelSettings(
  settings: TunnelSettings = getTunnelSettings(),
): PublicTunnelSettings {
  const {
    cloudflared_token,
    ngrok_authtoken,
    frpc_token,
    bore_secret,
    ...rest
  } = settings;
  return {
    ...rest,
    has_cloudflared_token: cloudflared_token.trim().length > 0,
    has_ngrok_authtoken: ngrok_authtoken.trim().length > 0,
    has_frpc_token: frpc_token.trim().length > 0,
    has_bore_secret: bore_secret.trim().length > 0,
  };
}

export function saveTunnelSettings(patch: TunnelSettingsPatch): TunnelSettings {
  const current = getTunnelSettings();
  const next: TunnelSettings = {
    ...current,
    provider:
      patch.provider !== undefined && VALID_TUNNEL_PROVIDERS.has(patch.provider)
        ? patch.provider
        : current.provider,
    auto_start:
      patch.auto_start !== undefined ? Boolean(patch.auto_start) : current.auto_start,
    auto_reconnect:
      patch.auto_reconnect !== undefined
        ? Boolean(patch.auto_reconnect)
        : current.auto_reconnect,
    local_host:
      patch.local_host !== undefined
        ? normalizeLocalHost(patch.local_host)
        : current.local_host,
    local_port:
      patch.local_port !== undefined
        ? clampPort(patch.local_port, current.local_port, true)
        : current.local_port,
    custom_domain:
      patch.custom_domain !== undefined
        ? normalizeDomain(patch.custom_domain)
        : current.custom_domain,
    prefer_https:
      patch.prefer_https !== undefined
        ? Boolean(patch.prefer_https)
        : current.prefer_https,
    cloudflared_mode:
      patch.cloudflared_mode !== undefined &&
      VALID_CF_MODES.has(patch.cloudflared_mode)
        ? patch.cloudflared_mode
        : current.cloudflared_mode,
    cloudflared_protocol:
      patch.cloudflared_protocol !== undefined &&
      VALID_CF_PROTOCOLS.has(patch.cloudflared_protocol)
        ? patch.cloudflared_protocol
        : current.cloudflared_protocol,
    cloudflared_binary_path:
      patch.cloudflared_binary_path !== undefined
        ? patch.cloudflared_binary_path.trim()
        : current.cloudflared_binary_path,
    ngrok_region:
      patch.ngrok_region !== undefined && VALID_NGROK_REGIONS.has(patch.ngrok_region)
        ? patch.ngrok_region
        : current.ngrok_region,
    ngrok_binary_path:
      patch.ngrok_binary_path !== undefined
        ? patch.ngrok_binary_path.trim()
        : current.ngrok_binary_path,
    frpc_server_addr:
      patch.frpc_server_addr !== undefined
        ? normalizeHostToken(patch.frpc_server_addr, "FRP server address")
        : current.frpc_server_addr,
    frpc_server_port:
      patch.frpc_server_port !== undefined
        ? clampPort(patch.frpc_server_port, current.frpc_server_port, false)
        : current.frpc_server_port,
    frpc_subdomain:
      patch.frpc_subdomain !== undefined
        ? normalizeHostToken(patch.frpc_subdomain, "FRP subdomain").toLowerCase()
        : current.frpc_subdomain,
    frpc_protocol:
      patch.frpc_protocol !== undefined &&
      VALID_FRPC_PROTOCOLS.has(patch.frpc_protocol)
        ? patch.frpc_protocol
        : current.frpc_protocol,
    frpc_binary_path:
      patch.frpc_binary_path !== undefined
        ? patch.frpc_binary_path.trim()
        : current.frpc_binary_path,
    bore_server:
      patch.bore_server !== undefined
        ? normalizeHostToken(patch.bore_server, "bore server") || "bore.pub"
        : current.bore_server,
    bore_remote_port:
      patch.bore_remote_port !== undefined
        ? clampPort(patch.bore_remote_port, current.bore_remote_port, true)
        : current.bore_remote_port,
    bore_binary_path:
      patch.bore_binary_path !== undefined
        ? patch.bore_binary_path.trim()
        : current.bore_binary_path,
    cloudflared_token: patch.clear_cloudflared_token
      ? ""
      : patch.cloudflared_token?.trim()
        ? patch.cloudflared_token.trim()
        : current.cloudflared_token,
    ngrok_authtoken: patch.clear_ngrok_authtoken
      ? ""
      : patch.ngrok_authtoken?.trim()
        ? patch.ngrok_authtoken.trim()
        : current.ngrok_authtoken,
    frpc_token: patch.clear_frpc_token
      ? ""
      : patch.frpc_token?.trim()
        ? patch.frpc_token.trim()
        : current.frpc_token,
    bore_secret: patch.clear_bore_secret
      ? ""
      : patch.bore_secret?.trim()
        ? patch.bore_secret.trim()
        : current.bore_secret,
  };

  query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(SETTINGS_KEY, JSON.stringify(next));

  const rt = getRuntime();
  if (
    next.provider !== current.provider ||
    next.ngrok_authtoken !== current.ngrok_authtoken
  ) {
    rt.lastError = null;
    if (rt.status === "error") {
      rt.status = "stopped";
    }
  }

  return next;
}

export function buildTunnelSpawnSpec(
  settings: TunnelSettings,
  binaryPath: string,
  effectivePort: number,
  opts?: { configDir?: string },
): TunnelSpawnSpec {
  const localHost = normalizeLocalHost(settings.local_host);
  const domain = normalizeDomain(settings.custom_domain);
  const scheme = settings.prefer_https ? "https" : "http";

  if (settings.provider === "cloudflared") {
    const protoArgs =
      settings.cloudflared_protocol !== "auto"
        ? ["--protocol", settings.cloudflared_protocol]
        : [];
    if (settings.cloudflared_mode === "token") {
      const token = settings.cloudflared_token.trim();
      if (!token) {
        throw new Error("Cloudflare Tunnel token is required for Named Tunnel mode.");
      }
      return {
        command: binaryPath,
        args: ["tunnel", "--no-autoupdate", ...protoArgs, "run"],
        env: { TUNNEL_TOKEN: token },
        expectedPublicUrl: domain ? `${scheme}://${domain}` : null,
      };
    }
    return {
      command: binaryPath,
      args: [
        "tunnel",
        "--no-autoupdate",
        ...protoArgs,
        "--url",
        `http://${formatHostPort(localHost, effectivePort)}`,
      ],
      env: {},
      expectedPublicUrl: null,
    };
  }

  if (settings.provider === "ngrok") {
    const args = [
      "http",
      formatHostPort(localHost, effectivePort),
      "--log=stdout",
      "--log-format=json",
    ];
    if (settings.ngrok_region !== "auto") {
      args.push("--region", settings.ngrok_region);
    }
    if (domain) {
      args.push(`--url=${domain}`);
    }
    const env: Record<string, string> = {};
    if (settings.ngrok_authtoken.trim()) {
      env.NGROK_AUTHTOKEN = settings.ngrok_authtoken.trim();
    }
    return {
      command: binaryPath,
      args,
      env,
      expectedPublicUrl: domain ? `${scheme}://${domain}` : null,
    };
  }

  if (settings.provider === "frpc") {
    const serverAddr = normalizeHostToken(
      settings.frpc_server_addr,
      "FRP server address",
    );
    if (!serverAddr) {
      throw new Error("FRP server address is required.");
    }
    const subdomain = settings.frpc_subdomain.trim().toLowerCase();
    if (!domain && !subdomain) {
      throw new Error("FRP requires either a custom domain or a subdomain.");
    }

    const dir = tunnelsConfigDir(opts?.configDir);
    mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, "frpc.toml");

    const lines = [
      `serverAddr = ${JSON.stringify(serverAddr)}`,
      `serverPort = ${settings.frpc_server_port}`,
    ];
    if (settings.frpc_token.trim()) {
      lines.push(`auth.method = "token"`);
      lines.push(`auth.token = ${JSON.stringify(settings.frpc_token.trim())}`);
    }
    lines.push(
      "",
      "[[proxies]]",
      `name = "uniroute"`,
      `type = ${JSON.stringify(settings.frpc_protocol)}`,
      `localIP = ${JSON.stringify(localHost)}`,
      `localPort = ${effectivePort}`,
    );
    if (domain) {
      lines.push(`customDomains = [${JSON.stringify(domain)}]`);
    }
    if (subdomain) {
      lines.push(`subdomain = ${JSON.stringify(subdomain)}`);
    }

    writeFileSync(configPath, `${lines.join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    if (process.platform !== "win32") {
      try {
        chmodSync(configPath, 0o600);
      } catch {
        // Ignore chmod failure on unsupported filesystems.
      }
    }

    const expectedPublicUrl = domain
      ? `${scheme}://${domain}`
      : `${scheme}://${subdomain}.${serverAddr}`;

    return {
      command: binaryPath,
      args: ["-c", configPath],
      env: {},
      expectedPublicUrl,
      configPath,
    };
  }

  const server =
    normalizeHostToken(settings.bore_server, "bore server") || "bore.pub";
  const args = [
    "local",
    String(effectivePort),
    "--local-host",
    localHost,
    "--to",
    server,
  ];
  if (settings.bore_remote_port > 0) {
    args.push("--port", String(settings.bore_remote_port));
  }
  const env: Record<string, string> = {};
  if (settings.bore_secret.trim()) {
    env.BORE_SECRET = settings.bore_secret.trim();
  }
  return {
    command: binaryPath,
    args,
    env,
    expectedPublicUrl: null,
  };
}

export function parseTunnelOutputLine(
  provider: TunnelProviderId,
  line: string,
  settings: Pick<
    TunnelSettings,
    | "custom_domain"
    | "prefer_https"
    | "cloudflared_mode"
    | "frpc_server_addr"
    | "frpc_subdomain"
    | "frpc_protocol"
  >,
): ParsedTunnelOutput | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const scheme = settings.prefer_https ? "https" : "http";
  let domain = "";
  try {
    domain = normalizeDomain(settings.custom_domain);
  } catch {
    domain = "";
  }
  const domainUrl = domain ? `${scheme}://${domain}` : undefined;

  if (provider === "cloudflared") {
    const quickMatch = trimmed.match(
      /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i,
    );
    if (quickMatch) {
      return { publicUrl: quickMatch[0], connected: true };
    }
    if (/Registered tunnel connection/i.test(trimmed)) {
      return {
        connected: true,
        ...(domainUrl ? { publicUrl: domainUrl } : {}),
      };
    }
    if (
      /failed to request quick tunnel|Provided Tunnel token is not valid|tunnel credentials|Unauthorized/i.test(
        trimmed,
      )
    ) {
      return { error: trimmed };
    }
    return null;
  }

  if (provider === "ngrok") {
    if (trimmed.startsWith("{")) {
      try {
        const obj = JSON.parse(trimmed) as {
          url?: unknown;
          lvl?: unknown;
          err?: unknown;
          msg?: unknown;
        };
        if (typeof obj.url === "string" && /^https?:\/\//i.test(obj.url)) {
          return { publicUrl: obj.url, connected: true };
        }
        if (obj.lvl === "eror" || obj.lvl === "error" || typeof obj.err === "string") {
          const msg = String(obj.err || obj.msg || trimmed).trim();
          if (/ERR_NGROK_4018|authentication failed/i.test(msg)) {
            return {
              error:
                "ngrok requires an authtoken (ERR_NGROK_4018). Add your token below or switch to Cloudflared / Bore.",
              fatal: true,
            };
          }
          return { error: msg };
        }
      } catch {
        // Fall through to text regex matching.
      }
    }
    const urlMatch = trimmed.match(/\burl=(https?:\/\/[^\s"]+)/i);
    if (urlMatch) {
      return { publicUrl: urlMatch[1], connected: true };
    }
    return null;
  }

  if (provider === "frpc") {
    if (/start proxy success/i.test(trimmed)) {
      const sub = settings.frpc_subdomain.trim();
      const srv = settings.frpc_server_addr.trim();
      const publicUrl =
        domainUrl ?? (sub && srv ? `${scheme}://${sub}.${srv}` : undefined);
      return { connected: true, ...(publicUrl ? { publicUrl } : {}) };
    }
    if (/login to server failed|start error|connect to server error/i.test(trimmed)) {
      return { error: trimmed };
    }
    return null;
  }

  const boreMatch = trimmed.match(/listening at\s+([a-zA-Z0-9.-]+:\d+)/i);
  if (boreMatch) {
    return {
      connected: true,
      publicUrl: domainUrl ?? `http://${boreMatch[1]}`,
    };
  }
  if (/^\s*error:/i.test(trimmed)) {
    return { error: trimmed };
  }
  return null;
}

function appendLog(
  runtime: TunnelRuntimeInternal,
  stream: TunnelLogEntry["stream"],
  rawLine: string,
  secrets: string[],
): string {
  const clean = scrubSecrets(rawLine, secrets).trimEnd();
  if (!clean) return "";
  runtime.logs.push({
    ts: new Date().toISOString(),
    stream,
    line: clean.slice(0, 600),
  });
  if (runtime.logs.length > MAX_LOG_LINES) {
    runtime.logs.splice(0, runtime.logs.length - MAX_LOG_LINES);
  }
  return clean;
}

function configuredBinaryForProvider(
  settings: TunnelSettings,
  provider: TunnelProviderId,
): string {
  if (provider === "cloudflared") return settings.cloudflared_binary_path;
  if (provider === "ngrok") return settings.ngrok_binary_path;
  if (provider === "frpc") return settings.frpc_binary_path;
  return settings.bore_binary_path;
}

function killChildProcess(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {
      // Ignore already exited child.
    }
  }, 1500);
  timer.unref?.();
}

type PersistedRuntimeState = {
  pid: number;
  provider: TunnelProviderId;
  publicUrl: string | null;
  localTarget: string | null;
  startedAt: number | null;
};

function canPersistRuntimeState(): boolean {
  return process.env.NODE_ENV !== "test" || Boolean(process.env.UNIROUTE_TUNNELS_DIR?.trim());
}

function runtimeStatePath(): string {
  return path.join(tunnelsConfigDir(), "runtime.json");
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const MISSING_DISK_CACHE_MS = 3_000;
let lastMissingCheckAt = 0;

function saveRuntimeToDisk(rt: TunnelRuntimeInternal): void {
  if (!canPersistRuntimeState() || !rt.pid) return;
  lastMissingCheckAt = 0;
  try {
    const p = runtimeStatePath();
    mkdirSync(path.dirname(p), { recursive: true });
    const data: PersistedRuntimeState = {
      pid: rt.pid,
      provider: rt.provider,
      publicUrl: rt.publicUrl,
      localTarget: rt.localTarget,
      startedAt: rt.startedAt,
    };
    writeFileSync(p, JSON.stringify(data), { encoding: "utf8", mode: 0o600 });
  } catch {
    // Ignore disk write failure for optional runtime cache.
  }
}

function clearRuntimeOnDisk(): void {
  if (!canPersistRuntimeState()) return;
  lastMissingCheckAt = Date.now();
  try {
    const p = runtimeStatePath();
    if (existsSync(p)) unlinkSync(p);
  } catch {
    // Ignore missing/locked runtime file cleanup.
  }
}

function hydrateRuntimeFromDisk(rt: TunnelRuntimeInternal): void {
  if (rt.child) return;

  if (rt.pid && !isPidAlive(rt.pid)) {
    rt.pid = null;
    rt.publicUrl = null;
    rt.startedAt = null;
    rt.status = "stopped";
    clearRuntimeOnDisk();
    return;
  }

  if (rt.status !== "stopped" || !canPersistRuntimeState()) return;
  const now = Date.now();
  if (now - lastMissingCheckAt < MISSING_DISK_CACHE_MS) return;

  const p = runtimeStatePath();
  if (!existsSync(p)) {
    lastMissingCheckAt = now;
    return;
  }
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<PersistedRuntimeState>;
    if (typeof raw.pid === "number" && isPidAlive(raw.pid)) {
      rt.pid = raw.pid;
      if (raw.provider && VALID_TUNNEL_PROVIDERS.has(raw.provider)) {
        rt.provider = raw.provider;
      }
      rt.publicUrl = typeof raw.publicUrl === "string" ? raw.publicUrl : null;
      rt.localTarget = typeof raw.localTarget === "string" ? raw.localTarget : null;
      rt.startedAt = typeof raw.startedAt === "number" ? raw.startedAt : null;
      rt.status = rt.publicUrl ? "running" : "starting";
    } else {
      clearRuntimeOnDisk();
    }
  } catch {
    clearRuntimeOnDisk();
  }
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
  } catch {
    return false;
  }
}

function extractRequestOrigin(request?: Request): string {
  if (!request) return "";
  try {
    const url = new URL(request.url);
    const xfHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const xfProtoRaw = request.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase();
    if (xfHost && !/[\s/@\\?#]/.test(xfHost)) {
      const proto =
        xfProtoRaw === "http" || xfProtoRaw === "https"
          ? xfProtoRaw
          : url.protocol.replace(/:$/, "");
      if (proto === "http" || proto === "https") {
        const parsed = new URL(`${proto}://${xfHost}`);
        if (parsed.host && parsed.pathname === "/") {
          return parsed.origin.replace(/\/+$/, "");
        }
      }
    }
    return url.origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

export function resolveGatewayOrigin(request?: Request): string {
  const tunnelUrl = getActiveTunnelUrl()?.trim().replace(/\/+$/, "");
  if (tunnelUrl) return tunnelUrl;

  const requestOrigin = extractRequestOrigin(request);
  const envBase = process.env.BASE_URL?.trim().replace(/\/+$/, "") || "";

  if (requestOrigin && !isLoopbackOrigin(requestOrigin) && (!envBase || isLoopbackOrigin(envBase))) {
    return requestOrigin;
  }
  if (envBase) return envBase;
  return requestOrigin || "http://localhost:3000";
}

export function clearTunnelLogs(): void {
  getRuntime().logs = [];
}

export function clearTunnelError(): TunnelRuntimeStatus {
  const rt = getRuntime();
  rt.lastError = null;
  if (rt.status === "error") {
    rt.status = "stopped";
  }
  return getTunnelStatus();
}

export function getActiveTunnelUrl(): string | null {
  const rt = getRuntime();
  hydrateRuntimeFromDisk(rt);
  return rt.status === "running" && rt.publicUrl ? rt.publicUrl : null;
}

export function getTunnelStatus(): TunnelRuntimeStatus {
  const rt = getRuntime();
  hydrateRuntimeFromDisk(rt);
  return {
    status: rt.status,
    provider: rt.provider,
    publicUrl: rt.publicUrl,
    localTarget: rt.localTarget,
    pid: rt.pid,
    startedAt: rt.startedAt,
    reconnectAttempts: rt.reconnectAttempts,
    lastError: rt.lastError,
    logs: [...rt.logs],
  };
}

export function stopTunnel(): TunnelRuntimeStatus {
  const rt = getRuntime();
  hydrateRuntimeFromDisk(rt);
  rt.manualStop = true;
  rt.generation += 1;
  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = null;
  }
  const child = rt.child;
  const orphanPid = !child ? rt.pid : null;
  rt.child = null;
  rt.pid = null;
  rt.startedAt = null;
  rt.publicUrl = null;
  rt.status = "stopped";
  rt.reconnectAttempts = 0;
  rt.lastError = null;
  clearRuntimeOnDisk();
  killChildProcess(child);
  if (orphanPid) {
    try {
      process.kill(orphanPid, "SIGTERM");
    } catch {
      // Ignore already exited orphan process.
    }
  }
  appendLog(rt, "system", "Tunnel stopped.", []);
  return getTunnelStatus();
}

export function stopTunnelProcess(): void {
  const rt = getRuntime();
  hydrateRuntimeFromDisk(rt);
  rt.manualStop = true;
  rt.generation += 1;
  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = null;
  }
  const child = rt.child;
  const orphanPid = !child ? rt.pid : null;
  rt.child = null;
  rt.pid = null;
  clearRuntimeOnDisk();
  killChildProcess(child);
  if (orphanPid) {
    try {
      process.kill(orphanPid, "SIGTERM");
    } catch {
      // Ignore already exited orphan process.
    }
  }
}

export async function syncRunningTunnelDomain(
  next: TunnelSettings,
  prev: TunnelSettings,
): Promise<{ restarted: boolean; updatedUrl: boolean }> {
  const rt = getRuntime();
  hydrateRuntimeFromDisk(rt);
  if (rt.status === "stopped" || rt.status === "error") {
    return { restarted: false, updatedUrl: false };
  }
  if (
    next.custom_domain === prev.custom_domain &&
    next.prefer_https === prev.prefer_https
  ) {
    return { restarted: false, updatedUrl: false };
  }
  if (rt.provider === "cloudflared" && next.cloudflared_mode === "token") {
    const scheme = next.prefer_https ? "https" : "http";
    rt.publicUrl = next.custom_domain ? `${scheme}://${next.custom_domain}` : null;
    saveRuntimeToDisk(rt);
    return { restarted: false, updatedUrl: true };
  }
  if (rt.provider === "ngrok" || rt.provider === "frpc") {
    await startTunnel({ waitMs: 6000 });
    return { restarted: true, updatedUrl: true };
  }
  return { restarted: false, updatedUrl: false };
}

export async function startTunnel(opts?: {
  port?: number;
  provider?: TunnelProviderId;
  waitMs?: number;
}): Promise<TunnelRuntimeStatus> {
  const rt = getRuntime();
  if (rt.reconnectTimer) {
    clearTimeout(rt.reconnectTimer);
    rt.reconnectTimer = null;
  }
  if (rt.child) {
    killChildProcess(rt.child);
    rt.child = null;
  }

  let settings = getTunnelSettings();
  if (opts?.provider && VALID_TUNNEL_PROVIDERS.has(opts.provider)) {
    settings = { ...settings, provider: opts.provider };
  }

  const port =
    settings.local_port > 0
      ? settings.local_port
      : (opts?.port ?? rt.serverPort ?? Number(process.env.PORT ?? 3000));
  if (opts?.port && !rt.serverPort) {
    rt.serverPort = opts.port;
  }

  const localHost = normalizeLocalHost(settings.local_host);
  const resolved = resolveTunnelBinary(
    settings.provider,
    configuredBinaryForProvider(settings, settings.provider),
  );
  if (!resolved.resolvedPath) {
    const msg = `${settings.provider} binary is not installed. Download it from the Tunneling page first.`;
    rt.status = "error";
    rt.provider = settings.provider;
    rt.lastError = msg;
    rt.publicUrl = null;
    rt.pid = null;
    throw new Error(msg);
  }

  const effectiveHost = await resolveReachableLocalHost(localHost, port);
  const spec = buildTunnelSpawnSpec(
    { ...settings, local_host: effectiveHost },
    resolved.resolvedPath,
    port,
  );
  const secrets = [
    settings.cloudflared_token,
    settings.ngrok_authtoken,
    settings.frpc_token,
    settings.bore_secret,
  ].filter(Boolean);

  rt.manualStop = false;
  rt.generation += 1;
  const gen = rt.generation;
  rt.provider = settings.provider;
  rt.status = "starting";
  rt.publicUrl = spec.expectedPublicUrl;
  rt.localTarget = formatHostPort(effectiveHost, port);
  rt.lastError = null;
  rt.startedAt = Date.now();

  if (effectiveHost !== localHost) {
    appendLog(
      rt,
      "system",
      `Loopback ${formatHostPort(localHost, port)} unreachable; using ${formatHostPort(effectiveHost, port)}.`,
      secrets,
    );
  }

  appendLog(
    rt,
    "system",
    `Starting ${settings.provider} -> ${rt.localTarget}...`,
    secrets,
  );

  const child = spawn(spec.command, spec.args, {
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  rt.child = child;
  rt.pid = child.pid ?? null;
  saveRuntimeToDisk(rt);

  let fatalError = false;
  let settleWait: (() => void) | null = null;
  const resolveWait = () => {
    if (settleWait) {
      const fn = settleWait;
      settleWait = null;
      fn();
    }
  };

  const handleChunk = (stream: "stdout" | "stderr") => {
    let buffer = "";
    return (chunk: Buffer | string) => {
      if (rt.generation !== gen) return;
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const clean = appendLog(rt, stream, line, secrets);
        if (!clean) continue;
        const parsed = parseTunnelOutputLine(settings.provider, line, settings);
        if (!parsed) continue;
        if (parsed.publicUrl) {
          rt.publicUrl = parsed.publicUrl;
          saveRuntimeToDisk(rt);
        }
        if (parsed.connected) {
          rt.status = "running";
          rt.reconnectAttempts = 0;
          rt.lastError = null;
          saveRuntimeToDisk(rt);
          if (rt.publicUrl) {
            resolveWait();
          } else if (settings.provider === "cloudflared" && settings.cloudflared_mode === "token") {
            resolveWait();
          }
        }
        if (parsed.error) {
          rt.lastError = scrubSecrets(parsed.error, secrets);
        }
        if (parsed.fatal) {
          fatalError = true;
        }
      }
    };
  };

  child.stdout?.on("data", handleChunk("stdout"));
  child.stderr?.on("data", handleChunk("stderr"));

  child.on("error", (err) => {
    if (rt.generation !== gen) return;
    rt.lastError = scrubSecrets(err.message, secrets);
    rt.status = "error";
    rt.child = null;
    rt.pid = null;
    clearRuntimeOnDisk();
    appendLog(rt, "system", `Process error: ${rt.lastError}`, secrets);
    resolveWait();
  });

  child.on("exit", (code, signal) => {
    if (rt.generation !== gen) return;
    rt.child = null;
    rt.pid = null;
    clearRuntimeOnDisk();

    if (rt.manualStop) {
      rt.status = "stopped";
      resolveWait();
      return;
    }

    const reason =
      rt.lastError ||
      `Tunnel process exited (${code !== null ? `code ${code}` : `signal ${signal ?? "unknown"}`}).`;
    rt.lastError = reason;
    appendLog(rt, "system", reason, secrets);
    resolveWait();

    const latest = getTunnelSettings();
    if (latest.auto_reconnect && !fatalError) {
      const attempt = rt.reconnectAttempts + 1;
      rt.reconnectAttempts = attempt;
      const delay =
        RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)]!;
      rt.status = "reconnecting";
      appendLog(
        rt,
        "system",
        `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})...`,
        secrets,
      );
      rt.reconnectTimer = setTimeout(() => {
        rt.reconnectTimer = null;
        if (rt.manualStop || rt.generation !== gen) return;
        startTunnel({ port: rt.serverPort ?? undefined, waitMs: 0 }).catch((err) => {
          rt.status = "error";
          rt.lastError = err instanceof Error ? err.message : String(err);
        });
      }, delay);
      rt.reconnectTimer.unref?.();
    } else {
      rt.status = "error";
    }
  });

  const waitMs = opts?.waitMs ?? 5000;
  if (waitMs > 0) {
    await new Promise<void>((resolve) => {
      settleWait = resolve;
      const t = setTimeout(resolveWait, waitMs);
      t.unref?.();
    });
  }

  return getTunnelStatus();
}

export function ensureTunnelFromSettings(opts?: { port?: number }): void {
  const rt = getRuntime();
  if (opts?.port) {
    rt.serverPort = opts.port;
  }
  const settings = getTunnelSettings();
  if (!settings.auto_start || rt.child || rt.status === "running" || rt.status === "starting") {
    return;
  }
  startTunnel({ port: opts?.port, waitMs: 0 }).catch((err) => {
    rt.status = "error";
    rt.lastError = err instanceof Error ? err.message : String(err);
  });
}

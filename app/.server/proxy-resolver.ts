import { query } from "./db";
import { getRoutingCredential } from "./credential";

export type ProxyProtocol = "http" | "socks5";

export type ProxyRow = {
  id: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  is_active: number;
  last_used_at: number;
  created_at: number;
};

export type ProxyConfig = {
  id: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

export type ProxyInput = {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

const PROXY_COLS = "id, protocol, host, port, username, password, is_active, last_used_at, created_at";

export function listProxies(): ProxyRow[] {
  return query(
    `SELECT ${PROXY_COLS} FROM proxies ORDER BY id`,
  ).all() as unknown as ProxyRow[];
}

export function getProxy(id: number): ProxyRow | undefined {
  const row = query(
    `SELECT ${PROXY_COLS} FROM proxies WHERE id = ?`,
  ).get(id) as unknown as ProxyRow | undefined;
  return row ?? undefined;
}

export function upsertProxy(
  input: ProxyInput,
): { id: number; inserted: boolean } {
  const res = query(
    `INSERT INTO proxies (protocol, host, port, username, password)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(host, port, protocol) DO NOTHING`,
  ).run(
    input.protocol,
    input.host,
    input.port,
    input.username,
    input.password,
  );
  const inserted = (res as { changes: number }).changes > 0;
  const row = query(
    "SELECT id FROM proxies WHERE host = ? AND port = ? AND protocol = ? LIMIT 1",
  ).get(input.host, input.port, input.protocol) as { id: number } | undefined;
  return { id: row?.id ?? -1, inserted };
}

export function updateProxy(id: number, fields: ProxyInput): void {
  query(
    `UPDATE proxies SET protocol = ?, host = ?, port = ?, username = ?, password = ?
     WHERE id = ?`,
  ).run(fields.protocol, fields.host, fields.port, fields.username, fields.password, id);
}

export function setProxyActive(id: number, active: boolean): void {
  query("UPDATE proxies SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function deleteProxy(id: number): void {
  query("DELETE FROM provider_proxies WHERE proxy_id = ?").run(id);
  query("UPDATE provider_credentials SET proxy_id = NULL WHERE proxy_id = ?").run(id);
  query("DELETE FROM proxies WHERE id = ?").run(id);
}

export function assignProxies(providerId: string, proxyIds: number[]): void {
  for (const proxyId of proxyIds) {
    query(
      "INSERT OR IGNORE INTO provider_proxies (provider_id, proxy_id) VALUES (?, ?)",
    ).run(providerId, proxyId);
  }
}

export function removeProxyAssignment(providerId: string, proxyId: number): void {
  query("DELETE FROM provider_proxies WHERE provider_id = ? AND proxy_id = ?").run(
    providerId,
    proxyId,
  );
}

export type AssignmentRow = {
  provider_id: string;
  provider_name: string;
  proxy_id: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
};

export function listAssignments(): AssignmentRow[] {
  return query(
    `SELECT pr.id AS provider_id, pr.name AS provider_name, px.id AS proxy_id,
            px.protocol, px.host, px.port
     FROM provider_proxies pp
     JOIN proxies px ON px.id = pp.proxy_id
     JOIN providers pr ON pr.id = pp.provider_id
     ORDER BY pr.id, px.port`,
  ).all() as unknown as AssignmentRow[];
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function parsePlainLine(s: string): ProxyInput | { error: string } {
  if (s.startsWith("[")) {
    const m = s.match(/^\[([^\]]+)\](?::(\d+))?(?::(.*))?$/);
    if (!m || !m[1]) return { error: "invalid format" };
    const port = m[2] ? Number(m[2]) : 1080;
    if (!validPort(port)) return { error: "invalid port" };
    let username: string | null = null;
    let password: string | null = null;
    if (m[3]) {
      const [u, ...rest] = m[3].split(":");
      username = u || null;
      password = rest.join(":") || null;
    }
    return { protocol: "http", host: m[1], port, username, password };
  }
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 4) return { error: "invalid format" };
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !validPort(port)) return { error: "invalid format" };
  let username: string | null = null;
  let password: string | null = null;
  if (parts.length === 3) {
    username = parts[2] || null;
  } else if (parts.length === 4) {
    username = parts[2] || null;
    password = parts[3];
  }
  return { protocol: "http", host, port, username, password };
}

function parseUrlLine(s: string): ProxyInput | { error: string } {
  const m = s.match(
    /^(https?|socks5):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/]+):(\d+)\/?$/i,
  );
  if (!m) return { error: "invalid URL format" };
  const scheme = m[1]!.toLowerCase();
  const host = m[4]!.startsWith("[") ? m[4]!.slice(1, -1) : m[4]!;
  const port = Number(m[5]);
  if (!validPort(port)) return { error: "invalid port" };
  return {
    protocol: scheme === "socks5" ? "socks5" : "http",
    host,
    port,
    username: m[2] != null ? decodeURIComponent(m[2]) : null,
    password: m[3] != null ? decodeURIComponent(m[3]) : null,
  };
}

export function parseBulkProxies(
  text: string,
  existing: ProxyConfig[] = [],
): { imported: ProxyInput[]; skipped: string[] } {
  const imported: ProxyInput[] = [];
  const skipped: string[] = [];
  const known = new Set(
    existing.map((p) => `${p.protocol}://${p.host}:${p.port}`),
  );
  const push = (item: ProxyInput | { error: string }, label: string): void => {
    if ("error" in item) {
      skipped.push(`${label}: ${item.error}`);
      return;
    }
    const key = `${item.protocol}://${item.host}:${item.port}`;
    if (known.has(key)) {
      skipped.push(`duplicate: ${key}`);
      return;
    }
    known.add(key);
    imported.push(item);
  };
  const trimmed = text.trim();
  if (trimmed === "") return { imported, skipped };

  let raw: unknown;
  let isJson = false;
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      raw = JSON.parse(trimmed);
      isJson = true;
    } catch {
      // not JSON; fall through to line-by-line parsing
    }
  }
  if (isJson) {
    const items = Array.isArray(raw) ? raw : [raw];
    items.forEach((item, i) => {
      const label = `item ${i + 1}`;
      if (typeof item !== "object" || item === null) {
        skipped.push(`${label}: invalid format`);
        return;
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj.host !== "string" || typeof obj.port !== "number") {
        skipped.push(`${label}: host/port required`);
        return;
      }
      const protocol =
        typeof obj.protocol === "string" ? obj.protocol.toLowerCase() : "http";
      if (protocol !== "http" && protocol !== "socks5") {
        skipped.push(`${label}: protocol harus http/socks5`);
        return;
      }
      if (!validPort(obj.port)) {
        skipped.push(`${label}: invalid port`);
        return;
      }
      push(
        {
          protocol,
          host: obj.host,
          port: obj.port,
          username:
            typeof obj.username === "string" && obj.username !== "" ? obj.username : null,
          password:
            typeof obj.password === "string" && obj.password !== "" ? obj.password : null,
        },
        label,
      );
    });
    return { imported, skipped };
  }

  text.split("\n").forEach((line, i) => {
    const l = line.trim();
    if (l === "") return;
    push(l.includes("://") ? parseUrlLine(l) : parsePlainLine(l), `line ${i + 1}`);
  });
  return { imported, skipped };
}

export function formatProxy(
  proxy: ProxyConfig,
): { proxy: string } | { socks: string } {
  const cred = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? "")}@`
    : "";
  const host =
    proxy.host.includes(":") && !proxy.host.startsWith("[")
      ? `[${proxy.host}]`
      : proxy.host;
  const url = `${proxy.protocol}://${cred}${host}:${proxy.port}`;
  return proxy.protocol === "http" ? { proxy: url } : { socks: url };
}

export function touchProxy(id: number): void {
  query("UPDATE proxies SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}

export function getActivePool(providerId: string): ProxyConfig[] {
  const rows = query(
    `SELECT px.id, px.protocol, px.host, px.port, px.username, px.password, px.last_used_at
     FROM provider_proxies pp
     JOIN proxies px ON px.id = pp.proxy_id
     WHERE pp.provider_id = ? AND px.is_active = 1
     ORDER BY px.last_used_at, px.id`,
  ).all(providerId) as unknown as (ProxyConfig & { last_used_at: number })[];
  return rows.map(({ last_used_at: _omit, ...rest }) => rest);
}

export function roundRobinPick(pool: ProxyConfig[]): ProxyConfig | undefined {
  if (pool.length === 0) return undefined;
  const picked = pool[0];
  touchProxy(picked.id);
  return picked;
}

function getKeyProxy(providerId: string): ProxyConfig | null {
  const cred = getRoutingCredential(providerId);
  if (!cred?.proxy_id) return null;
  const row = query(
    "SELECT id, protocol, host, port, username, password FROM proxies WHERE id = ? AND is_active = 1",
  ).get(cred.proxy_id) as ProxyConfig | undefined;
  return row ?? null;
}

export function resolveProxy(providerId: string): ProxyConfig | null {
  const keyProxy = getKeyProxy(providerId);
  if (keyProxy) return keyProxy;
  const pool = getActivePool(providerId);
  if (pool.length === 0) return null;
  return roundRobinPick(pool) ?? null;
}

export function resolveProxyCandidates(providerId: string): ProxyConfig[] {
  const keyProxy = getKeyProxy(providerId);
  if (keyProxy) return [keyProxy];
  const pool = getActivePool(providerId);
  if (pool.length === 0) return [];
  const picked = roundRobinPick(pool);
  return [picked!, ...pool.filter((p) => p.id !== picked!.id)];
}

export function fetchUpstream(
  url: string,
  init: RequestInit & { proxy?: string; socks?: string },
  proxy: ProxyConfig | null,
): Promise<Response> {
  return fetch(url, proxy ? { ...init, ...formatProxy(proxy) } : init);
}

export async function testProxyConnection(
  proxy: ProxyConfig,
): Promise<{ ok: boolean; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchUpstream(
      "https://www.gstatic.com/generate_204",
      { method: "GET", signal: controller.signal },
      proxy,
    );
    return { ok: true, message: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function resolveProxyForKey(
  providerId: string,
  keyProxyId: number | null,
): ProxyConfig | null {
  if (keyProxyId) {
    const row = query(
      "SELECT id, protocol, host, port, username, password FROM proxies WHERE id = ? AND is_active = 1",
    ).get(keyProxyId) as ProxyConfig | undefined;
    if (row) return row;
  }
  const pool = getActivePool(providerId);
  if (pool.length === 0) return null;
  return roundRobinPick(pool) ?? null;
}

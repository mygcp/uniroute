import { query } from "./db";

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
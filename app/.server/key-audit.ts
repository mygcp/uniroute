import { query } from "./db";

export type AuditEntry = {
  id: number;
  key_id: number;
  action: string;
  model: string | null;
  provider_id: string | null;
  status: number | null;
  tokens: number | null;
  cost: number | null;
  details: string | null;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
};

export type AuditInput = Partial<
  Omit<AuditEntry, "id" | "key_id" | "created_at">
>;

const AUDIT_COLUMNS =
  "id, key_id, action, model, provider_id, status, tokens, cost, details, ip, user_agent, created_at";

const AUDIT_FIELDS: (keyof AuditInput)[] = [
  "model",
  "provider_id",
  "status",
  "tokens",
  "cost",
  "details",
  "ip",
  "user_agent",
];

export function logAudit(keyId: number, action: string, input?: AuditInput): void {
  const fields = input ?? {};
  const cols = ["key_id", "action"];
  const vals: unknown[] = [keyId, action];
  for (const field of AUDIT_FIELDS) {
    if (fields[field] !== undefined) {
      cols.push(field);
      vals.push(fields[field]);
    }
  }
  query(
    `INSERT INTO key_audit_logs (${cols.join(", ")}) VALUES (${cols
      .map(() => "?")
      .join(", ")})`,
  ).run(...vals);
}

function mapRows(rows: Record<string, unknown>[]): AuditEntry[] {
  return rows.map((r) => ({
    id: Number(r.id),
    key_id: Number(r.key_id),
    action: String(r.action),
    model: r.model == null ? null : String(r.model),
    provider_id: r.provider_id == null ? null : String(r.provider_id),
    status: r.status == null ? null : Number(r.status),
    tokens: r.tokens == null ? null : Number(r.tokens),
    cost: r.cost == null ? null : Number(r.cost),
    details: r.details == null ? null : String(r.details),
    ip: r.ip == null ? null : String(r.ip),
    user_agent: r.user_agent == null ? null : String(r.user_agent),
    created_at: Number(r.created_at),
  }));
}

function clampLimit(limit?: number): number {
  const raw = limit ?? 50;
  if (!Number.isFinite(raw)) return 50;
  return Math.max(1, Math.min(Math.floor(raw), 500));
}

export function listAudit(keyId: number, limit?: number): AuditEntry[] {
  const clamped = clampLimit(limit);
  return mapRows(
    query(
      `SELECT ${AUDIT_COLUMNS} FROM key_audit_logs WHERE key_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(keyId, clamped) as Record<string, unknown>[],
  );
}

export function recentAudit(keyId: number, sinceTs: number): AuditEntry[] {
  return mapRows(
    query(
      `SELECT ${AUDIT_COLUMNS} FROM key_audit_logs WHERE key_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC`,
    ).all(keyId, sinceTs) as Record<string, unknown>[],
  );
}

export function auditErrorsLastHour(keyId: number): number {
  const since = Math.floor(Date.now() / 1000) - 3600;
  const row = query(
    `SELECT COUNT(*) AS c FROM key_audit_logs WHERE key_id = ? AND action = 'REQUEST' AND status >= 400 AND created_at >= ?`,
  ).get(keyId, since) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

export function avgLatencyMs(keyId: number, sinceTs: number): number | null {
  const cols = (
    query("PRAGMA table_info(request_logs)").all() as { name: string }[]
  ).map((c) => c.name);
  if (!cols.includes("api_key_id")) return null;
  const row = query(
    "SELECT AVG(duration_ms) AS a FROM request_logs WHERE api_key_id = ? AND created_at >= ?",
  ).get(keyId, sinceTs) as { a: number | null } | undefined;
  const avg = row?.a;
  return avg == null ? null : Number(avg);
}
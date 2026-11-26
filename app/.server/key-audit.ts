import { exec, hasColumn, onBeforeRead, onDbReset, onShutdownFlush, query } from "./db";

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

type QueuedAudit = {
  keyId: number;
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

const MAX_AUDIT_QUEUE = 5000;
const auditQueue: QueuedAudit[] = [];
let auditTimer: ReturnType<typeof setTimeout> | null = null;

export function flushAuditQueue(): void {
  if (auditTimer) {
    clearTimeout(auditTimer);
    auditTimer = null;
  }
  if (auditQueue.length === 0) return;
  const items = auditQueue.splice(0);
  exec("BEGIN");
  try {
    const stmt = query(
      `INSERT INTO key_audit_logs
         (key_id, action, model, provider_id, status, tokens, cost, details, ip, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      stmt.run(
        item.keyId,
        item.action,
        item.model,
        item.provider_id,
        item.status,
        item.tokens,
        item.cost,
        item.details,
        item.ip,
        item.user_agent,
        item.created_at,
      );
    }
    exec("COMMIT");
  } catch (err) {
    exec("ROLLBACK");
    throw err;
  }
}

onBeforeRead("key_audit_logs", flushAuditQueue);
onShutdownFlush(flushAuditQueue);
onDbReset(() => {
  auditQueue.length = 0;
  if (auditTimer) {
    clearTimeout(auditTimer);
    auditTimer = null;
  }
});

export function logAudit(keyId: number, action: string, input?: AuditInput): void {
  if (auditQueue.length >= MAX_AUDIT_QUEUE) {
    auditQueue.shift();
  }
  const fields = input ?? {};
  auditQueue.push({
    keyId,
    action,
    model: fields.model ?? null,
    provider_id: fields.provider_id ?? null,
    status: fields.status ?? null,
    tokens: fields.tokens ?? null,
    cost: fields.cost ?? null,
    details: fields.details ?? null,
    ip: fields.ip ?? null,
    user_agent: fields.user_agent ?? null,
    created_at: Math.floor(Date.now() / 1000),
  });
  if (auditQueue.length >= 64) {
    flushAuditQueue();
    return;
  }
  if (!auditTimer) {
    auditTimer = setTimeout(flushAuditQueue, 50);
    auditTimer.unref?.();
  }
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
  flushAuditQueue();
  const clamped = clampLimit(limit);
  return mapRows(
    query(
      `SELECT ${AUDIT_COLUMNS} FROM key_audit_logs WHERE key_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(keyId, clamped) as Record<string, unknown>[],
  );
}

export function recentAudit(keyId: number, sinceTs: number): AuditEntry[] {
  flushAuditQueue();
  return mapRows(
    query(
      `SELECT ${AUDIT_COLUMNS} FROM key_audit_logs WHERE key_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC`,
    ).all(keyId, sinceTs) as Record<string, unknown>[],
  );
}

export function hasBudgetAlertSince(keyId: number, sinceTs: number): boolean {
  flushAuditQueue();
  const row = query(
    `SELECT 1 AS ok FROM key_audit_logs WHERE key_id = ? AND action IN ('BUDGET_ALERT', 'BUDGET_BLOCKED') AND created_at >= ? LIMIT 1`,
  ).get(keyId, sinceTs) as { ok: number } | undefined;
  return Boolean(row);
}

export function auditErrorsLastHour(keyId: number): number {
  flushAuditQueue();
  const since = Math.floor(Date.now() / 1000) - 3600;
  const row = query(
    `SELECT COUNT(*) AS c FROM key_audit_logs WHERE key_id = ? AND action = 'REQUEST' AND status >= 400 AND created_at >= ?`,
  ).get(keyId, since) as { c: number } | undefined;
  return Number(row?.c ?? 0);
}

export function avgLatencyMs(keyId: number, sinceTs: number): number | null {
  if (!hasColumn("request_logs", "api_key_id")) return null;
  const row = query(
    "SELECT AVG(duration_ms) AS a FROM request_logs WHERE api_key_id = ? AND created_at >= ?",
  ).get(keyId, sinceTs) as { a: number | null } | undefined;
  const avg = row?.a;
  return avg == null ? null : Number(avg);
}

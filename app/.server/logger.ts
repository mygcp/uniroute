import { exec, query } from "./db";
import { broadcast } from "./log-stream";

export type RequestLog = {
  model: string;
  provider_id: string;
  strategy_used?: string | null;
  rule_applied?: string | null;
  duration_ms?: number | null;
  status: "success" | "error" | "timeout" | "denied";
  error_message?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  api_key_id?: number | null;
};

export type ProxyLog = {
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
};

type InsertResult = { lastInsertRowid?: number | bigint; changes?: number | bigint };

type InsertedLog = {
  type: "request" | "proxy";
  log: RequestLog | ProxyLog;
  id: number;
};

const requestQueue: RequestLog[] = [];
const proxyQueue: ProxyLog[] = [];
let flushing = false;

/**
 * Wirte queued logs to the DB and return what was inserted (with real ids).
 * Logs are written BEFORE being broadcast so live events carry a usable id
 * (delete / detail views depend on it).
 */
function flushInserted(): InsertedLog[] {
  if (flushing) return [];
  flushing = true;
  const inserted: InsertedLog[] = [];
  try {
    exec("BEGIN");
    try {
      const insertReq = query(
        `INSERT INTO request_logs
           (model, provider_id, strategy_used, rule_applied, duration_ms, status, error_message, prompt_tokens, completion_tokens, api_key_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const log of requestQueue.splice(0)) {
        const res = insertReq.run(
          log.model,
          log.provider_id,
          log.strategy_used ?? null,
          log.rule_applied ?? null,
          log.duration_ms ?? null,
          log.status,
          log.error_message ?? null,
          log.prompt_tokens ?? null,
          log.completion_tokens ?? null,
          log.api_key_id ?? null,
          Date.now(),
        ) as InsertResult;
        inserted.push({ type: "request", log, id: Number(res.lastInsertRowid) });
      }

      const insertProxy = query(
        `INSERT INTO proxy_logs (level, source, message, metadata, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const log of proxyQueue.splice(0)) {
        const res = insertProxy.run(
          log.level,
          log.source,
          log.message,
          log.metadata ? JSON.stringify(log.metadata) : null,
          Date.now(),
        ) as InsertResult;
        inserted.push({ type: "proxy", log, id: Number(res.lastInsertRowid) });
      }
      exec("COMMIT");
    } catch (e) {
      exec("ROLLBACK");
      throw e;
    }
  } finally {
    flushing = false;
  }
  return inserted;
}

function flushAndBroadcast(): void {
  const inserted = flushInserted();
  for (const { type, log, id } of inserted) {
    broadcast({ type, id, ...log, created_at: Date.now() });
  }
}

export function recordRequestLog(log: RequestLog): void {
  requestQueue.push(log);
  queueMicrotask(flushAndBroadcast);
}

export function recordProxyLog(log: ProxyLog): void {
  proxyQueue.push(log);
  queueMicrotask(flushAndBroadcast);
}

/** Drain queued logs synchronously — dipanggil saat graceful shutdown. */
export function flushLogs(): void {
  flushInserted();
}
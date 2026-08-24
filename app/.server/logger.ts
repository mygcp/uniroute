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
  /** Token yang dilayani dari cache provider (subset input). */
  cached_tokens?: number | null;
  api_key_id?: number | null;
  /** 1 = lewat outbound proxy, 0 = direct. */
  via_proxy?: number | null;
  proxy_id?: number | null;
  /** Jenis endpoint: chat-completions | messages | responses | combo. */
  endpoint?: string | null;
  /** 1 = koneksi upstream memakai https. */
  upstream_tls?: number | null;
};

export type ProxyLog = {
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
  client_ip?: string | null;
  api_key_id?: number | null;
  provider_id?: string | null;
  proxy_id?: number | null;
  latency_ms?: number | null;
  endpoint?: string | null;
};

type InsertResult = { lastInsertRowid?: number | bigint; changes?: number | bigint };

type InsertedLog = {
  type: "request" | "proxy";
  log: RequestLog | ProxyLog;
  id: number;
  /** Timestamp yang benar-benar disimpan ke DB (dipakai ulang saat broadcast). */
  created_at: number;
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
           (model, provider_id, strategy_used, rule_applied, duration_ms, status, error_message, prompt_tokens, completion_tokens, api_key_id, created_at, via_proxy, proxy_id, endpoint, upstream_tls, cached_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const log of requestQueue.splice(0)) {
        const createdAt = Date.now();
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
          createdAt,
          log.via_proxy ?? 0,
          log.proxy_id ?? null,
          log.endpoint ?? null,
          log.upstream_tls ?? null,
          log.cached_tokens ?? null,
        ) as InsertResult;
        inserted.push({
          type: "request",
          log,
          id: Number(res.lastInsertRowid),
          created_at: createdAt,
        });
      }

      const insertProxy = query(
        `INSERT INTO proxy_logs
           (level, source, message, metadata, created_at, client_ip, api_key_id, provider_id, proxy_id, latency_ms, endpoint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const log of proxyQueue.splice(0)) {
        const createdAt = Date.now();
        const res = insertProxy.run(
          log.level,
          log.source,
          log.message,
          log.metadata ? JSON.stringify(log.metadata) : null,
          createdAt,
          log.client_ip ?? null,
          log.api_key_id ?? null,
          log.provider_id ?? null,
          log.proxy_id ?? null,
          log.latency_ms ?? null,
          log.endpoint ?? null,
        ) as InsertResult;
        inserted.push({
          type: "proxy",
          log,
          id: Number(res.lastInsertRowid),
          created_at: createdAt,
        });
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
  for (const { type, log, id, created_at } of inserted) {
    broadcast({ type, id, ...log, created_at });
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
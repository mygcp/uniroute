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
};

export type ProxyLog = {
  level: "info" | "warn" | "error" | "debug";
  source: string;
  message: string;
  metadata?: Record<string, unknown>;
};

const requestQueue: RequestLog[] = [];
const proxyQueue: ProxyLog[] = [];
let flushing = false;

function flush() {
  if (flushing) return;
  flushing = true;
  try {
    exec("BEGIN");
    try {
      const insertReq = query(
        `INSERT INTO request_logs
           (model, provider_id, strategy_used, rule_applied, duration_ms, status, error_message, prompt_tokens, completion_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const log of requestQueue.splice(0)) {
        insertReq.run(
          log.model,
          log.provider_id,
          log.strategy_used ?? null,
          log.rule_applied ?? null,
          log.duration_ms ?? null,
          log.status,
          log.error_message ?? null,
          log.prompt_tokens ?? null,
          log.completion_tokens ?? null,
        );
      }

      const insertProxy = query(
        `INSERT INTO proxy_logs (level, source, message, metadata)
         VALUES (?, ?, ?, ?)`,
      );
      for (const log of proxyQueue.splice(0)) {
        insertProxy.run(
          log.level,
          log.source,
          log.message,
          log.metadata ? JSON.stringify(log.metadata) : null,
        );
      }
      exec("COMMIT");
    } catch (e) {
      exec("ROLLBACK");
      throw e;
    }
  } finally {
    flushing = false;
  }
}

export function recordRequestLog(log: RequestLog): void {
  requestQueue.push(log);
  queueMicrotask(flush);
  broadcast({ type: "request", ...log, created_at: Date.now() });
}

export function recordProxyLog(log: ProxyLog): void {
  proxyQueue.push(log);
  queueMicrotask(flush);
  broadcast({ type: "proxy", ...log, created_at: Date.now() });
}

/** Drain queued logs synchronously — dipanggil saat graceful shutdown. */
export function flushLogs(): void {
  flush();
}
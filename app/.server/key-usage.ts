import { exec, onBeforeRead, onDbReset, onShutdownFlush, query } from "./db";

const DAY_MS = 86_400_000;
const BATCH_MS = 50;

export type UsageDelta = {
  requests?: number;
  promptTokens?: number;
  completionTokens?: number;
  cost?: number;
};

export type UsageSummary = {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
};

export type UsageRow = {
  date: string;
  requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost: number;
};

type QueuedUsage = {
  keyId: number;
  date: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cost: number;
};

const pendingUsage = new Map<string, QueuedUsage>();
let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;

export function flushUsageQueue(): void {
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
  if (pendingUsage.size === 0) return;
  const items = [...pendingUsage.values()];
  pendingUsage.clear();

  exec("BEGIN");
  try {
    const stmt = query(
      `INSERT INTO key_usage_daily (key_id, date, requests, prompt_tokens, completion_tokens, cost)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key_id, date) DO UPDATE SET
         requests = requests + excluded.requests,
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         cost = cost + excluded.cost`,
    );
    for (const item of items) {
      stmt.run(
        item.keyId,
        item.date,
        item.requests,
        item.promptTokens,
        item.completionTokens,
        item.cost,
      );
    }
    exec("COMMIT");
  } catch (err) {
    exec("ROLLBACK");
    throw err;
  }
}

onBeforeRead("key_usage_daily", flushUsageQueue);
onShutdownFlush(flushUsageQueue);
onDbReset(() => {
  pendingUsage.clear();
  if (usageFlushTimer) {
    clearTimeout(usageFlushTimer);
    usageFlushTimer = null;
  }
});

function dayStart(ts: number): number {
  return Math.floor(ts / DAY_MS) * DAY_MS;
}

function dayStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function dateBounds(fromTs: number, toTs: number): [string, string] {
  const from = dayStr(dayStart(fromTs));
  const toAligned = toTs % DAY_MS === 0 ? toTs : dayStart(toTs) + DAY_MS;
  return [from, dayStr(toAligned)];
}

function sumInRange(keyId: number, fromTs: number, toTs: number): UsageSummary {
  flushUsageQueue();
  const [from, to] = dateBounds(fromTs, toTs);
  const row = query(
    `SELECT COALESCE(SUM(requests), 0) AS requests,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(cost), 0) AS cost
       FROM key_usage_daily
      WHERE key_id = ? AND date >= ? AND date < ?`,
  ).get(keyId, from, to) as Record<string, unknown>;
  return {
    requests: Number(row.requests),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    cost: Number(row.cost),
  };
}

export function recordUsage(keyId: number, delta: UsageDelta): void {
  const date = new Date().toISOString().slice(0, 10);
  const mapKey = `${keyId}:${date}`;
  const existing = pendingUsage.get(mapKey);
  if (existing) {
    existing.requests += delta.requests ?? 0;
    existing.promptTokens += delta.promptTokens ?? 0;
    existing.completionTokens += delta.completionTokens ?? 0;
    existing.cost += delta.cost ?? 0;
  } else {
    pendingUsage.set(mapKey, {
      keyId,
      date,
      requests: delta.requests ?? 0,
      promptTokens: delta.promptTokens ?? 0,
      completionTokens: delta.completionTokens ?? 0,
      cost: delta.cost ?? 0,
    });
  }
  if (pendingUsage.size >= 64) {
    flushUsageQueue();
    return;
  }
  if (!usageFlushTimer) {
    usageFlushTimer = setTimeout(flushUsageQueue, BATCH_MS);
    usageFlushTimer.unref?.();
  }
}

export function usageInRange(keyId: number, fromTs: number, toTs: number): UsageSummary {
  return sumInRange(keyId, fromTs, toTs);
}

export function usageToday(keyId: number): UsageSummary {
  const now = Date.now();
  return sumInRange(keyId, dayStart(now), dayStart(now) + DAY_MS);
}

export function usageThisMonth(keyId: number): UsageSummary {
  const now = new Date();
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return sumInRange(keyId, start, end);
}

export function usageLast30Days(keyId: number): UsageSummary {
  const now = Date.now();
  return sumInRange(keyId, now - 30 * DAY_MS, now);
}

export function usageByDay(keyId: number, days = 30): UsageRow[] {
  flushUsageQueue();
  const rows = query(
    `SELECT date, requests, prompt_tokens, completion_tokens, cost
       FROM key_usage_daily
      WHERE key_id = ?
      ORDER BY date DESC
      LIMIT ?`,
  ).all(keyId, days) as Record<string, unknown>[];
  return rows.reverse().map((row) => ({
    date: String(row.date),
    requests: Number(row.requests),
    prompt_tokens: Number(row.prompt_tokens),
    completion_tokens: Number(row.completion_tokens),
    cost: Number(row.cost),
  }));
}

import { TtlCache } from "./async-utils";
import { getTableVersion, onDbReset, query } from "./db";

type StatsResult = {
  total: number;
  success: number;
  successRate: number;
  avgLatency: number;
  activeProviders: number;
  totalProviders: number;
  today: number;
};

type WeekSummaryResult = {
  requests: number;
  ok: number;
  tokens: number;
};

const statsCache = new TtlCache<string, unknown>(8, 3000);
onDbReset(() => statsCache.clear());

export function getStats(): StatsResult {
  const ver = `${getTableVersion("request_logs")}:${getTableVersion("providers")}`;
  const cached = statsCache.get(`stats:${ver}`) as StatsResult | undefined;
  if (cached) return cached;

  const startOfUtcDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const reqRow = query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
            AVG(duration_ms) AS avg_latency,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS today
       FROM request_logs`,
  ).get(startOfUtcDay) as {
    total: number;
    success: number;
    avg_latency: number | null;
    today: number;
  };

  const provRow = query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END), 0) AS active
       FROM providers`,
  ).get() as { total: number; active: number };

  const total = Number(reqRow.total ?? 0);
  const success = Number(reqRow.success ?? 0);
  const result: StatsResult = {
    total,
    success,
    successRate: total ? Math.round((success / total) * 100) : 0,
    avgLatency: Math.round(Number(reqRow.avg_latency ?? 0)),
    activeProviders: Number(provRow.active ?? 0),
    totalProviders: Number(provRow.total ?? 0),
    today: Number(reqRow.today ?? 0),
  };
  statsCache.set(`stats:${ver}`, result);
  return result;
}

export function getUsageWeekSummary(): WeekSummaryResult {
  const ver = getTableVersion("request_logs");
  const cached = statsCache.get(`week:${ver}`) as WeekSummaryResult | undefined;
  if (cached) return cached;

  const startOfUtcDay7 =
    Math.floor(Date.now() / 86_400_000) * 86_400_000 - 6 * 86_400_000;
  const row = query(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS ok,
            COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) AS tokens
       FROM request_logs
      WHERE created_at >= ?`,
  ).get(startOfUtcDay7) as {
    requests: number;
    ok: number;
    tokens: number;
  };
  const result: WeekSummaryResult = {
    requests: Number(row.requests),
    ok: Number(row.ok),
    tokens: Number(row.tokens),
  };
  statsCache.set(`week:${ver}`, result);
  return result;
}

export function getUsageLast7Days(): { day: string; count: number }[] {
  const ver = getTableVersion("request_logs");
  const cached = statsCache.get(`last7:${ver}`) as { day: string; count: number }[] | undefined;
  if (cached) return cached;

  const rows = query(
    `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS c
     FROM request_logs
     WHERE created_at >= (strftime('%s','now','-6 days') * 1000)
     GROUP BY day ORDER BY day`,
  ).all() as { day: string; c: number }[];

  const byDay = new Map(rows.map((r) => [r.day, Number(r.c)]));
  const days: { day: string; count: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86_400_000);
    const key = d.toISOString().slice(0, 10);
    days.push({ day: key, count: byDay.get(key) ?? 0 });
  }
  statsCache.set(`last7:${ver}`, days);
  return days;
}

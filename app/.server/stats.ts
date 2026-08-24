import { query } from "./db";

export function getStats() {
  const total =
    (query("SELECT COUNT(*) AS c FROM request_logs").get() as { c: number }).c ??
    0;
  const success =
    (query("SELECT COUNT(*) AS c FROM request_logs WHERE status = 'success'")
      .get() as { c: number }).c ?? 0;
  const avgLatency =
    (query("SELECT AVG(duration_ms) AS a FROM request_logs").get() as {
      a: number | null;
    }).a ?? 0;
  const activeProviders =
    (query("SELECT COUNT(*) AS c FROM providers WHERE is_active = 1").get() as {
      c: number;
    }).c ?? 0;

  const startOfUtcDay = Math.floor(Date.now() / 86_400_000) * 86_400_000;
  const today =
    (
      query("SELECT COUNT(*) AS c FROM request_logs WHERE created_at >= ?").get(
        startOfUtcDay,
      ) as { c: number }
    ).c ?? 0;

  const totalProviders =
    (query("SELECT COUNT(*) AS c FROM providers").get() as { c: number }).c ?? 0;

  return {
    total,
    success,
    successRate: total ? Math.round((success / total) * 100) : 0,
    avgLatency: Math.round(avgLatency),
    activeProviders,
    totalProviders,
    today,
  };
}

/** Ringkasan pemakaian 7 hari terakhir (request, sukses, token). */
export function getUsageWeekSummary() {
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
  return {
    requests: Number(row.requests),
    ok: Number(row.ok),
    tokens: Number(row.tokens),
  };
}

export function getUsageLast7Days() {
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
  return days;
}
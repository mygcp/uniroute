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

  return {
    total,
    successRate: total ? Math.round((success / total) * 100) : 0,
    avgLatency: Math.round(avgLatency),
    activeProviders,
  };
}

export function getUsageLast7Days() {
  const rows = query(
    `SELECT date(created_at, 'unixepoch') AS day, COUNT(*) AS c
     FROM request_logs
     WHERE created_at >= strftime('%s','now','-6 days')
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
import { query } from "./db";
import { getPrice } from "./pricing";

export type TimeRange = "day" | "week" | "month" | "year" | "all";
export type Metric = "tokens" | "cost";
export type Dimension = "provider" | "model" | "apikey";

export type UsageSummary = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
};

export type Performance = {
  requests: number;
  successRate: number;
  avgLatencyMs: number;
  tokensPerReq: number;
  costPerReq: number;
};

export type Trends = {
  totalTokens: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  cost: number | null;
  requests: number | null;
  successRate: number | null;
  avgLatencyMs: number | null;
  tokensPerReq: number | null;
};

export type Errors = {
  success: number;
  error: number;
  total: number;
  top: { message: string; count: number }[];
};

export type TimeSeriesPoint = {
  label: string;
  labelFull: string;
  value: number;
};

export type BreakdownEntry = {
  name: string;
  value: number;
  pct: number;
};

export type LatencyStats = {
  p50: number;
  p95: number;
};

export type ModelInsight = {
  model: string;
  providers: string[];
  requests: number;
  tokens: number;
  cost: number;
  errors: number;
  errorRate: number;
  avgTokensPerReq: number;
};

export type UsageData = {
  summary: UsageSummary;
  performance: Performance;
  trends: Trends;
  errors: Errors;
  timeSeries: TimeSeriesPoint[];
  breakdown: BreakdownEntry[];
  /** Success-rate (%) per time bucket — backs the success-trend toggle. */
  successTrend: TimeSeriesPoint[];
  /** p50/p95 of duration_ms for the range (0 when no samples). */
  latency: LatencyStats;
  /** Per-model aggregates (top 10 by cost) for drilldown tables. */
  modelInsights: ModelInsight[];
  range: TimeRange;
  metric: Metric;
  dimension: Dimension;
};

const DAY_MS = 86_400_000;

type PricePair = { input: number; output: number };

/**
 * Cache harga per kombinasi model::provider untuk satu batch perhitungan.
 * Tanpa ini, loop cost memanggil getPrice (2 query) untuk SETIAP baris log.
 */
function priceLookup(
  rows: Array<Record<string, unknown>>,
): (model: unknown, providerId: unknown) => PricePair {
  const cache = new Map<string, PricePair>();
  return (model, providerId) => {
    const key = `${String(model ?? "").toLowerCase()}::${String(
      providerId ?? "",
    ).toLowerCase()}`;
    let price = cache.get(key);
    if (!price) {
      price = getPrice(String(model ?? ""), String(providerId ?? ""));
      cache.set(key, price);
    }
    return price;
  };
}

function computeCost(
  promptTokens: number | null,
  completionTokens: number | null,
  price: PricePair,
): number {
  const pt = promptTokens ?? 0;
  const ct = completionTokens ?? 0;
  return (pt * price.input) / 1_000_000 + (ct * price.output) / 1_000_000;
}

function rangeBounds(range: TimeRange): [number, number] {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  switch (range) {
    case "day":
      return [Date.UTC(y, m, d), Date.now()];
    case "week": {
      const todayStart = Date.UTC(y, m, d);
      const dow = now.getUTCDay(); // 0 = Sun
      const daysSinceMon = dow === 0 ? 6 : dow - 1;
      return [todayStart - daysSinceMon * DAY_MS, Date.now()];
    }
    case "month":
      return [Date.UTC(y, m, 1), Date.now()];
    case "year":
      return [Date.UTC(y, 0, 1), Date.now()];
    case "all":
      return [0, Date.now()];
  }
}

function prevRangeBounds(range: TimeRange): [number, number] | null {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const todayStart = Date.UTC(y, m, d);
  switch (range) {
    case "day":
      return [todayStart - DAY_MS, todayStart];
    case "week": {
      const dow = now.getUTCDay(); // 0 = Sun
      const daysSinceMon = dow === 0 ? 6 : dow - 1;
      const thisMon = todayStart - daysSinceMon * DAY_MS;
      return [thisMon - 7 * DAY_MS, thisMon];
    }
    case "month":
      return [Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1)];
    case "year":
      return [Date.UTC(y - 1, 0, 1), Date.UTC(y, 0, 1)];
    case "all":
      return null;
  }
}

function dateExpr(range: TimeRange): string {
  if (range === "day") return `strftime('%Y-%m-%d %H:00', created_at / 1000, 'unixepoch')`;
  if (range === "year" || range === "all") return `strftime('%Y-%m', created_at / 1000, 'unixepoch')`;
  return `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')`;
}

function shortLabel(dt: string, range: TimeRange): string {
  if (range === "day") return dt.slice(11, 16); // "14:00"
  if (range === "year" || range === "all") {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[parseInt(dt.slice(5, 7), 10) - 1];
  }
  const [, mo, day] = dt.split("-");
  return `${parseInt(mo, 10)}/${parseInt(day, 10)}`;
}

function buildGroupCol(dim: Dimension): string {
  switch (dim) {
    case "provider":
      return "provider_id";
    case "model":
      return "model";
    case "apikey":
      return "COALESCE(api_key_id, 0)";
  }
}

function groupLabel(grp: string | number, dim: Dimension): string {
  if (dim === "apikey") return grp === 0 || grp === "0" ? "No API Key" : `Key #${grp}`;
  return String(grp);
}

function _querySummaryFor(bounds: [number, number]): UsageSummary {
  const [fromTs, toTs] = bounds;
  const sumRow = query(
    `SELECT COALESCE(SUM(prompt_tokens), 0) AS pt,
            COALESCE(SUM(completion_tokens), 0) AS ct,
            COALESCE(SUM(cached_tokens), 0) AS cache
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?`,
  ).get(fromTs, toTs) as { pt: number; ct: number; cache: number };
  const pt = Number(sumRow.pt);
  const ct = Number(sumRow.ct);
  const cache = Number(sumRow.cache);

  const rows = query(
    `SELECT prompt_tokens, completion_tokens, model, provider_id
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
        AND (prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL)`,
  ).all(fromTs, toTs) as Record<string, unknown>[];
  const priceOf = priceLookup(rows);
  const cost = rows.reduce(
    (s, r) =>
      s +
      computeCost(
        r.prompt_tokens as number | null,
        r.completion_tokens as number | null,
        priceOf(r.model, r.provider_id),
      ),
    0,
  );

  return { totalTokens: pt + ct, inputTokens: pt, outputTokens: ct, cachedTokens: cache, cost };
}

function _querySummary(range: TimeRange): UsageSummary {
  return _querySummaryFor(rangeBounds(range));
}

function _queryPerformanceFor(bounds: [number, number], tokens: number, cost: number): Performance {
  const [fromTs, toTs] = bounds;
  const row = query(
    `SELECT COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS ok,
            AVG(duration_ms) AS avgDur
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?`,
  ).get(fromTs, toTs) as { requests: number; ok: number; avgDur: number | null };
  const requests = Number(row.requests);
  const ok = Number(row.ok);
  const avgDur = Number(row.avgDur ?? 0);
  return {
    requests,
    successRate: requests ? Math.round((ok / requests) * 100) : 0,
    avgLatencyMs: Math.round(avgDur),
    tokensPerReq: requests ? tokens / requests : 0,
    costPerReq: requests ? cost / requests : 0,
  };
}

function pctDelta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

function pointDelta(curr: number, prev: number): number | null {
  return Math.round((curr - prev) * 10) / 10;
}

function _queryTrends(range: TimeRange, summary: UsageSummary, performance: Performance): Trends {
  const prev = prevRangeBounds(range);
  if (!prev) {
    return {
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      cachedTokens: null,
      cost: null,
      requests: null,
      successRate: null,
      avgLatencyMs: null,
      tokensPerReq: null,
    };
  }
  const prevSummary = _querySummaryFor(prev);
  const prevPerf = _queryPerformanceFor(prev, prevSummary.totalTokens, prevSummary.cost);
  return {
    totalTokens: pctDelta(summary.totalTokens, prevSummary.totalTokens),
    inputTokens: pctDelta(summary.inputTokens, prevSummary.inputTokens),
    outputTokens: pctDelta(summary.outputTokens, prevSummary.outputTokens),
    cachedTokens: pctDelta(summary.cachedTokens, prevSummary.cachedTokens),
    cost: pctDelta(summary.cost, prevSummary.cost),
    requests: pctDelta(performance.requests, prevPerf.requests),
    successRate: prevPerf.requests ? pointDelta(performance.successRate, prevPerf.successRate) : null,
    avgLatencyMs: prevPerf.requests ? pctDelta(performance.avgLatencyMs, prevPerf.avgLatencyMs) : null,
    tokensPerReq: prevPerf.requests ? pctDelta(performance.tokensPerReq, prevPerf.tokensPerReq) : null,
  };
}

function _queryErrors(range: TimeRange): Errors {
  const [fromTs, toTs] = rangeBounds(range);
  const statusRows = query(
    `SELECT status, COUNT(*) AS c
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
      GROUP BY status`,
  ).all(fromTs, toTs) as { status: string; c: number }[];
  const counts = new Map(statusRows.map((r) => [r.status, Number(r.c)]));
  const total = statusRows.reduce((s, r) => s + Number(r.c), 0);
  const success = counts.get("success") ?? 0;
  const error = total - success;
  const errRows = query(
    `SELECT error_message, COUNT(*) AS c
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
        AND status != 'success'
        AND error_message IS NOT NULL
      GROUP BY error_message ORDER BY c DESC LIMIT 5`,
  ).all(fromTs, toTs) as { error_message: string; c: number }[];
  return {
    success,
    error,
    total,
    top: errRows.map((r) => ({ message: String(r.error_message), count: Number(r.c) })),
  };
}

function _queryTimeSeries(range: TimeRange, metric: Metric): TimeSeriesPoint[] {
  const [fromTs, toTs] = rangeBounds(range);
  const dtExpr = dateExpr(range);

  if (metric === "tokens") {
    const rows = query(
      `SELECT ${dtExpr} AS dt,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) AS val
         FROM request_logs
        WHERE created_at >= ? AND created_at < ?
        GROUP BY dt ORDER BY dt`,
    ).all(fromTs, toTs) as { dt: string; val: number }[];
    return rows.map((r) => ({ label: shortLabel(r.dt, range), labelFull: r.dt, value: Number(r.val) }));
  }

  const rows = query(
    `SELECT ${dtExpr} AS dt, prompt_tokens, completion_tokens, model, provider_id
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?`,
  ).all(fromTs, toTs) as Record<string, unknown>[];
  const priceOf = priceLookup(rows);
  const map = new Map<string, number>();
  for (const r of rows) {
    const dt = r.dt as string;
    map.set(
      dt,
      (map.get(dt) ?? 0) +
        computeCost(
          r.prompt_tokens as number | null,
          r.completion_tokens as number | null,
          priceOf(r.model, r.provider_id),
        ),
    );
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dt, value]) => ({ label: shortLabel(dt, range), labelFull: dt, value }));
}

function _formatBreakdown(
  rows: { grp: string | number; val: number }[],
  total: number,
  dim: Dimension,
): BreakdownEntry[] {
  const format = (r: { grp: string | number; val: number }): BreakdownEntry => ({
    name: groupLabel(r.grp, dim),
    value: Number(r.val),
    pct: total ? Math.round((Number(r.val) / total) * 100) : 0,
  });
  if (rows.length > 10) {
    const top = rows.slice(0, 10);
    const others = rows.slice(10);
    const otherVal = others.reduce((s, r) => s + Number(r.val), 0);
    return [
      ...top.map(format),
      { name: "Other", value: otherVal, pct: total ? Math.round((otherVal / total) * 100) : 0 },
    ];
  }
  return rows.map(format);
}

function _queryBreakdown(range: TimeRange, metric: Metric, dim: Dimension): BreakdownEntry[] {
  const [fromTs, toTs] = rangeBounds(range);
  const groupCol = buildGroupCol(dim);

  if (metric === "tokens") {
    const rows = query(
      `SELECT ${groupCol} AS grp,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) AS val
         FROM request_logs
        WHERE created_at >= ? AND created_at < ?
        GROUP BY grp ORDER BY val DESC LIMIT 11`,
    ).all(fromTs, toTs) as { grp: string | number; val: number }[];
    const total = rows.reduce((s, r) => s + Number(r.val), 0);
    return _formatBreakdown(rows, total, dim);
  }

  const rows = query(
    `SELECT ${groupCol} AS grp, prompt_tokens, completion_tokens, model, provider_id
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?`,
  ).all(fromTs, toTs) as Record<string, unknown>[];
  const priceOf = priceLookup(rows);
  const map = new Map<string, number>();
  for (const r of rows) {
    const grp = String(r.grp);
    map.set(
      grp,
      (map.get(grp) ?? 0) +
        computeCost(
          r.prompt_tokens as number | null,
          r.completion_tokens as number | null,
          priceOf(r.model, r.provider_id),
        ),
    );
  }
  const sorted = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 11);
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  return _formatBreakdown(
    sorted.map(([grp, val]) => ({ grp, val })),
    total,
    dim,
  );
}

export function getUsageData(opts: {
  range: TimeRange;
  metric?: Metric;
  dimension?: Dimension;
}): UsageData {
  const { range } = opts;
  const metric = opts.metric ?? "tokens";
  const dimension = opts.dimension ?? "provider";
  const summary = _querySummary(range);
  const performance = _queryPerformanceFor(rangeBounds(range), summary.totalTokens, summary.cost);
  return {
    summary,
    performance,
    trends: _queryTrends(range, summary, performance),
    errors: _queryErrors(range),
    timeSeries: _queryTimeSeries(range, metric),
    breakdown: _queryBreakdown(range, metric, dimension),
    successTrend: _querySuccessTrend(range),
    latency: _queryLatency(range),
    modelInsights: _queryModelInsights(range),
    range,
    metric,
    dimension,
  };
}

function _queryLatency(range: TimeRange): LatencyStats {
  const [fromTs, toTs] = rangeBounds(range);
  const rows = query(
    `SELECT duration_ms AS d
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
        AND duration_ms IS NOT NULL
      ORDER BY d`,
  ).all(fromTs, toTs) as { d: number }[];
  if (rows.length === 0) return { p50: 0, p95: 0 };
  const pick = (p: number): number =>
    Math.round(Number(rows[Math.min(rows.length - 1, Math.ceil(p * rows.length) - 1)].d));
  return { p50: pick(0.5), p95: pick(0.95) };
}

function _querySuccessTrend(range: TimeRange): TimeSeriesPoint[] {
  const [fromTs, toTs] = rangeBounds(range);
  const dtExpr = dateExpr(range);
  const rows = query(
    `SELECT ${dtExpr} AS dt,
            COUNT(*) AS c,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS ok
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
      GROUP BY dt ORDER BY dt`,
  ).all(fromTs, toTs) as { dt: string; c: number; ok: number }[];
  return rows.map((r) => {
    const total = Number(r.c);
    const ok = Number(r.ok);
    return {
      label: shortLabel(r.dt, range),
      labelFull: r.dt,
      value: total ? Math.round((ok / total) * 1000) / 10 : 0,
    };
  });
}

function _queryModelInsights(range: TimeRange): ModelInsight[] {
  const [fromTs, toTs] = rangeBounds(range);
  const rows = query(
    `SELECT model, provider_id, prompt_tokens, completion_tokens, status
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?`,
  ).all(fromTs, toTs) as Record<string, unknown>[];
  const priceOf = priceLookup(rows);
  const map = new Map<
    string,
    { providers: Set<string>; requests: number; tokens: number; cost: number; errors: number }
  >();
  for (const r of rows) {
    const model = String(r.model ?? "unknown");
    let entry = map.get(model);
    if (!entry) {
      entry = { providers: new Set(), requests: 0, tokens: 0, cost: 0, errors: 0 };
      map.set(model, entry);
    }
    entry.providers.add(String(r.provider_id ?? "unknown"));
    entry.requests += 1;
    entry.tokens += Number(r.prompt_tokens ?? 0) + Number(r.completion_tokens ?? 0);
    entry.cost += computeCost(
      r.prompt_tokens as number | null,
      r.completion_tokens as number | null,
      priceOf(r.model, r.provider_id),
    );
    if (r.status !== "success") entry.errors += 1;
  }
  return Array.from(map.entries())
    .map(([model, e]) => ({
      model,
      providers: Array.from(e.providers).sort(),
      requests: e.requests,
      tokens: e.tokens,
      cost: Math.round(e.cost * 1_000_000) / 1_000_000,
      errors: e.errors,
      errorRate: e.requests ? Math.round((e.errors / e.requests) * 100) : 0,
      avgTokensPerReq: e.requests ? Math.round(e.tokens / e.requests) : 0,
    }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 10);
}
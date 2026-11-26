import { TtlCache } from "./async-utils";
import { getTableVersion, onDbReset, query } from "./db";
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
  successTrend: TimeSeriesPoint[];
  latency: LatencyStats;
  modelInsights: ModelInsight[];
  range: TimeRange;
  metric: Metric;
  dimension: Dimension;
};

const DAY_MS = 86_400_000;
const usageCache = new TtlCache<string, UsageData>(32, 5000);
onDbReset(() => usageCache.clear());

type PricePair = { input: number; output: number };

function createPriceLookup(): (model: unknown, providerId: unknown) => PricePair {
  const cache = new Map<string, PricePair>();
  return (model, providerId) => {
    const m = String(model ?? "");
    const p = String(providerId ?? "");
    const key = `${m.toLowerCase()}::${p.toLowerCase()}`;
    let price = cache.get(key);
    if (!price) {
      price = getPrice(m, p);
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
      const dow = now.getUTCDay();
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
      const dow = now.getUTCDay();
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
  if (range === "day") return dt.slice(11, 16);
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

type AggModelProvRow = {
  model: string | null;
  provider_id: string | null;
  reqs: number;
  ok: number;
  pt: number;
  ct: number;
  cached: number;
  sum_dur: number;
  cnt_dur: number;
};

function queryAggByModelProvider(bounds: [number, number]): {
  summary: UsageSummary;
  performance: Performance;
  modelInsights: ModelInsight[];
} {
  const [fromTs, toTs] = bounds;
  const rows = query(
    `SELECT model, provider_id,
            COUNT(*) AS reqs,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS ok,
            COALESCE(SUM(prompt_tokens), 0) AS pt,
            COALESCE(SUM(completion_tokens), 0) AS ct,
            COALESCE(SUM(cached_tokens), 0) AS cached,
            COALESCE(SUM(duration_ms), 0) AS sum_dur,
            COUNT(duration_ms) AS cnt_dur
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
      GROUP BY model, provider_id`,
  ).all(fromTs, toTs) as unknown as AggModelProvRow[];

  const priceOf = createPriceLookup();
  let requests = 0;
  let okCount = 0;
  let pt = 0;
  let ct = 0;
  let cached = 0;
  let cost = 0;
  let sumDur = 0;
  let cntDur = 0;

  const modelMap = new Map<
    string,
    { providers: Set<string>; requests: number; tokens: number; cost: number; errors: number }
  >();

  for (const r of rows) {
    const rReqs = Number(r.reqs);
    const rOk = Number(r.ok);
    const rPt = Number(r.pt);
    const rCt = Number(r.ct);
    const rCached = Number(r.cached);
    const rCost = computeCost(rPt, rCt, priceOf(r.model, r.provider_id));

    requests += rReqs;
    okCount += rOk;
    pt += rPt;
    ct += rCt;
    cached += rCached;
    cost += rCost;
    sumDur += Number(r.sum_dur);
    cntDur += Number(r.cnt_dur);

    const modelName = String(r.model ?? "unknown");
    let entry = modelMap.get(modelName);
    if (!entry) {
      entry = { providers: new Set(), requests: 0, tokens: 0, cost: 0, errors: 0 };
      modelMap.set(modelName, entry);
    }
    entry.providers.add(String(r.provider_id ?? "unknown"));
    entry.requests += rReqs;
    entry.tokens += rPt + rCt;
    entry.cost += rCost;
    entry.errors += rReqs - rOk;
  }

  const totalTokens = pt + ct;
  const avgDur = cntDur > 0 ? sumDur / cntDur : 0;

  const modelInsights: ModelInsight[] = Array.from(modelMap.entries())
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

  return {
    summary: { totalTokens, inputTokens: pt, outputTokens: ct, cachedTokens: cached, cost },
    performance: {
      requests,
      successRate: requests ? Math.round((okCount / requests) * 100) : 0,
      avgLatencyMs: Math.round(avgDur),
      tokensPerReq: requests ? totalTokens / requests : 0,
      costPerReq: requests ? cost / requests : 0,
    },
    modelInsights,
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
  const { summary: prevSummary, performance: prevPerf } = queryAggByModelProvider(prev);
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

function _queryErrors(bounds: [number, number]): Errors {
  const [fromTs, toTs] = bounds;
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

function _queryTimeAndSuccessSeries(
  bounds: [number, number],
  range: TimeRange,
  metric: Metric,
): { timeSeries: TimeSeriesPoint[]; successTrend: TimeSeriesPoint[] } {
  const [fromTs, toTs] = bounds;
  const dtExpr = dateExpr(range);

  if (metric === "tokens") {
    const rows = query(
      `SELECT ${dtExpr} AS dt,
              COUNT(*) AS c,
              COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS ok,
              COALESCE(SUM(prompt_tokens), 0) + COALESCE(SUM(completion_tokens), 0) AS val
         FROM request_logs
        WHERE created_at >= ? AND created_at < ?
        GROUP BY dt ORDER BY dt`,
    ).all(fromTs, toTs) as { dt: string; c: number; ok: number; val: number }[];
    return {
      timeSeries: rows.map((r) => ({ label: shortLabel(r.dt, range), labelFull: r.dt, value: Number(r.val) })),
      successTrend: rows.map((r) => {
        const total = Number(r.c);
        const ok = Number(r.ok);
        return {
          label: shortLabel(r.dt, range),
          labelFull: r.dt,
          value: total ? Math.round((ok / total) * 1000) / 10 : 0,
        };
      }),
    };
  }

  const rows = query(
    `SELECT ${dtExpr} AS dt,
            model,
            provider_id,
            COUNT(*) AS c,
            COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS ok,
            COALESCE(SUM(prompt_tokens), 0) AS pt,
            COALESCE(SUM(completion_tokens), 0) AS ct
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
      GROUP BY dt, model, provider_id ORDER BY dt`,
  ).all(fromTs, toTs) as {
    dt: string;
    model: string | null;
    provider_id: string | null;
    c: number;
    ok: number;
    pt: number;
    ct: number;
  }[];

  const priceOf = createPriceLookup();
  const byDt = new Map<string, { cost: number; total: number; ok: number }>();
  for (const r of rows) {
    let bucket = byDt.get(r.dt);
    if (!bucket) {
      bucket = { cost: 0, total: 0, ok: 0 };
      byDt.set(r.dt, bucket);
    }
    bucket.cost += computeCost(Number(r.pt), Number(r.ct), priceOf(r.model, r.provider_id));
    bucket.total += Number(r.c);
    bucket.ok += Number(r.ok);
  }
  const sorted = Array.from(byDt.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  return {
    timeSeries: sorted.map(([dt, b]) => ({
      label: shortLabel(dt, range),
      labelFull: dt,
      value: b.cost,
    })),
    successTrend: sorted.map(([dt, b]) => ({
      label: shortLabel(dt, range),
      labelFull: dt,
      value: b.total ? Math.round((b.ok / b.total) * 1000) / 10 : 0,
    })),
  };
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

function _queryBreakdown(
  bounds: [number, number],
  metric: Metric,
  dim: Dimension,
): BreakdownEntry[] {
  const [fromTs, toTs] = bounds;
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
    `SELECT ${groupCol} AS grp,
            model,
            provider_id,
            COALESCE(SUM(prompt_tokens), 0) AS pt,
            COALESCE(SUM(completion_tokens), 0) AS ct
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
      GROUP BY grp, model, provider_id`,
  ).all(fromTs, toTs) as {
    grp: string | number;
    model: string | null;
    provider_id: string | null;
    pt: number;
    ct: number;
  }[];
  const priceOf = createPriceLookup();
  const map = new Map<string, number>();
  for (const r of rows) {
    const grp = String(r.grp);
    map.set(
      grp,
      (map.get(grp) ?? 0) + computeCost(Number(r.pt), Number(r.ct), priceOf(r.model, r.provider_id)),
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

function _queryLatency(bounds: [number, number]): LatencyStats {
  const [fromTs, toTs] = bounds;
  const countRow = query(
    `SELECT COUNT(*) AS c
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
        AND duration_ms IS NOT NULL`,
  ).get(fromTs, toTs) as { c: number };
  const count = Number(countRow?.c ?? 0);
  if (count === 0) return { p50: 0, p95: 0 };

  const pickOffset = (p: number): number => {
    const offset = Math.min(count - 1, Math.max(0, Math.ceil(p * count) - 1));
    const row = query(
      `SELECT duration_ms AS d
         FROM request_logs
        WHERE created_at >= ? AND created_at < ?
          AND duration_ms IS NOT NULL
        ORDER BY duration_ms ASC
        LIMIT 1 OFFSET ?`,
    ).get(fromTs, toTs, offset) as { d: number } | undefined;
    return row ? Math.round(Number(row.d)) : 0;
  };
  return { p50: pickOffset(0.5), p95: pickOffset(0.95) };
}

export function getUsageSummaryOnly(range: TimeRange): {
  summary: UsageSummary;
  performance: Performance;
} {
  const { summary, performance } = queryAggByModelProvider(rangeBounds(range));
  return { summary, performance };
}

export function getUsageData(opts: {
  range: TimeRange;
  metric?: Metric;
  dimension?: Dimension;
}): UsageData {
  const { range } = opts;
  const metric = opts.metric ?? "tokens";
  const dimension = opts.dimension ?? "provider";
  const cacheKey = `${range}:${metric}:${dimension}:${getTableVersion("request_logs")}:${getTableVersion("model_pricing")}`;
  const cached = usageCache.get(cacheKey);
  if (cached) return cached;

  const bounds = rangeBounds(range);
  const { summary, performance, modelInsights } = queryAggByModelProvider(bounds);
  const { timeSeries, successTrend } = _queryTimeAndSuccessSeries(bounds, range, metric);

  const result: UsageData = {
    summary,
    performance,
    trends: _queryTrends(range, summary, performance),
    errors: _queryErrors(bounds),
    timeSeries,
    breakdown: _queryBreakdown(bounds, metric, dimension),
    successTrend,
    latency: _queryLatency(bounds),
    modelInsights,
    range,
    metric,
    dimension,
  };
  usageCache.set(cacheKey, result);
  return result;
}

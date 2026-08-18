# Usage Page Enhancement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the Usage page at `/analytics/usage` with request-volume/efficiency metrics, trend deltas vs the previous period, a Status & Errors section, and mobile-friendly HTML/CSS bar charts with staggered grow animations.

**Architecture:** Extend the existing server data layer (`app/.server/usage.ts`) to also return `performance`, `trends`, and `errors` computed with the same `rangeBounds` pattern plus a new `prevRangeBounds`. The two SVG chart components are rewritten as responsive HTML/CSS bars (no JS resize listeners, CSS-only animations). `StatCard` gains optional `delta`/`subline` props. The route renders 2 rows of 4 cards, the existing charts, and a new Status & Errors card.

**Tech Stack:** React Router v8 (loader + search params), TypeScript, SQLite (bun:sqlite via `db.ts`), Tailwind CSS v4 (`app.css`), hand-rolled HTML/CSS bars, `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-18-usage-page-enhancement-design.md`

## Global Constraints

- No new runtime dependencies.
- `request_logs.created_at` is stored in **milliseconds**; all SQL date math must use `created_at / 1000` with `'unixepoch'`.
- Cost is computed per row from `pricing.getPrice(model, providerId)`; never stored.
- Charts are HTML/CSS bars only — no SVG, no chart lib.
- Bar animations are pure CSS transforms (`scaleY`/`scaleX`) — the existing global `prefers-reduced-motion` rule in `app.css:260-267` already neutralizes them; do NOT add extra reduced-motion guards.
- Follow existing glass-UI conventions (`glass-panel`, `Tabs`, `StatCard`, `PageHeader`, `Card`, `CardHeader`, `CardTitle`).
- All UI copy in English.
- `StatCard` and `CardHeader` are shared components used by `home.tsx` and `api-manager*` routes — all new props must be optional and backward-compatible.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `app/.server/usage.ts` | Modify | Add `performance`, `trends`, `errors` to `UsageData`; `prevRangeBounds`, `_queryPerformanceFor`, `_queryTrends`, `_queryErrors` |
| `app/.server/usage.test.ts` | Modify | New tests: performance, trends, errors |
| `app/components/ui/stat-card.tsx` | Modify | Add optional `delta`, `deltaSuffix`, `subline` props |
| `app/app.css` | Modify | Add `grow-y`/`grow-x` keyframes + `.bar-grow-y`/`.bar-grow-x` classes |
| `app/components/usage/time-series-chart.tsx` | Rewrite | HTML/CSS vertical bars with stagger animation |
| `app/components/usage/breakdown-chart.tsx` | Rewrite | HTML/CSS horizontal bars with stagger animation |
| `app/routes/analytics.usage.tsx` | Modify | 8 stat cards + deltas, Status & Errors card, flex-wrap headers |

---

### Task 1: Data layer — `app/.server/usage.ts`

**Files:**
- Modify: `app/.server/usage.ts` (full rewrite below)
- Test: `app/.server/usage.test.ts`

**Interfaces:**
- Consumes: `query` from `./db`; `getPrice` from `./pricing`
- Produces (used by Tasks 4-6):
  - `export type Performance = { requests: number; successRate: number; avgLatencyMs: number; tokensPerReq: number; costPerReq: number }`
  - `export type Trends = { totalTokens: number | null; inputTokens: number | null; outputTokens: number | null; cost: number | null; requests: number | null; successRate: number | null; avgLatencyMs: number | null; tokensPerReq: number | null }`
  - `export type Errors = { success: number; error: number; total: number; top: { message: string; count: number }[] }`
  - `UsageData` gains `performance: Performance`, `trends: Trends`, `errors: Errors`

- [ ] **Step 1: Write the failing tests**

Append to `app/.server/usage.test.ts`:

```ts
function insertErrorLog(model: string, providerId: string, errorMessage: string, created_at: number): void {
  db.query(
    `INSERT INTO request_logs (model, provider_id, prompt_tokens, completion_tokens, api_key_id, created_at, status, error_message)
     VALUES (?, ?, NULL, NULL, NULL, ?, 'error', ?)`,
  ).run(model, providerId, created_at, errorMessage);
}
```

Replace the `beforeAll` block (lines 36-45) with:

```ts
beforeAll(async () => {
  await resetTestDb();
  usage = await import("./usage");
  db = await import("./db");
  const now = Date.now();
  insertLog({ model: "gpt-4o", provider_id: "openai", prompt_tokens: 1000, completion_tokens: 500, created_at: now });
  insertLog({ model: "gpt-4o", provider_id: "openai", prompt_tokens: 2000, completion_tokens: 1000, created_at: now - DAY_MS });
  insertLog({ model: "claude-3-5-sonnet", provider_id: "anthropic", prompt_tokens: 500, completion_tokens: 200, created_at: now - 2 * DAY_MS });
  insertLog({ model: "claude-3-5-sonnet", provider_id: "anthropic", prompt_tokens: null, completion_tokens: null, created_at: now - 100 * DAY_MS });
  insertErrorLog("gpt-4o", "openai", '{"error":{"message":"rate limit exceeded"}}', now - 2 * DAY_MS);
  insertErrorLog("gpt-4o", "openai", '{"error":{"message":"rate limit exceeded"}}', now - 3 * DAY_MS);
  insertErrorLog("gpt-4o", "openai", "model not found", now - 3 * DAY_MS);
});
```

Append these test suites (after the existing `breakdown` describe):

```ts
describe("getUsageData performance", () => {
  test("aggregates requests, success rate, latency, tokens/req, cost/req for range=all", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.performance.requests).toBe(7); // 4 success + 3 error
    expect(data.performance.successRate).toBe(57); // round(4/7*100)
    expect(data.performance.avgLatencyMs).toBe(0);
    expect(data.performance.tokensPerReq).toBeCloseTo(742.857, 1); // 5200/7
    expect(data.performance.costPerReq).toBeCloseTo(0.00386, 4); // 0.027/7
  });
});

describe("getUsageData trends", () => {
  test("range=all has no prior period (all null)", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.trends.totalTokens).toBeNull();
    expect(data.trends.requests).toBeNull();
    expect(data.trends.successRate).toBeNull();
  });

  test("range=day compares against yesterday", () => {
    const data = usage.getUsageData({ range: "day" });
    expect(data.summary.totalTokens).toBe(1500); // today: row at `now`
    expect(data.trends.totalTokens).toBe(-50); // (1500-3000)/3000
    expect(data.trends.inputTokens).toBe(-50);
    expect(data.trends.outputTokens).toBe(-50);
    expect(data.trends.cost).toBe(-50);
    expect(data.trends.requests).toBe(0);
    expect(data.trends.successRate).toBe(0); // absolute-point delta
    expect(data.trends.tokensPerReq).toBe(-50);
    expect(data.trends.avgLatencyMs).toBeNull();
  });
});

describe("getUsageData errors", () => {
  test("groups status counts and top error messages", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.errors.success).toBe(4);
    expect(data.errors.error).toBe(3);
    expect(data.errors.total).toBe(7);
    expect(data.errors.top).toHaveLength(2);
    expect(data.errors.top[0]).toEqual({ message: '{"error":{"message":"rate limit exceeded"}}', count: 2 });
    expect(data.errors.top[1]).toEqual({ message: "model not found", count: 1 });
  });

  test("range=day excludes previous days' errors", () => {
    const data = usage.getUsageData({ range: "day" });
    expect(data.errors.success).toBe(1);
    expect(data.errors.error).toBe(0);
    expect(data.errors.top).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `bun test app/.server/usage.test.ts`
Expected: FAIL — `performance` / `trends` / `errors` do not exist on `UsageData` (TypeScript errors and `expect(data.performance...` accessing `undefined`).

- [ ] **Step 3: Rewrite `app/.server/usage.ts`**

Replace the entire file with:

```ts
import { query } from "./db";
import { getPrice } from "./pricing";

export type TimeRange = "day" | "week" | "month" | "year" | "all";
export type Metric = "tokens" | "cost";
export type Dimension = "provider" | "model" | "apikey";

export type UsageSummary = {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
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

export type UsageData = {
  summary: UsageSummary;
  performance: Performance;
  trends: Trends;
  errors: Errors;
  timeSeries: TimeSeriesPoint[];
  breakdown: BreakdownEntry[];
  range: TimeRange;
  metric: Metric;
  dimension: Dimension;
};

const DAY_MS = 86_400_000;

function computeCost(
  promptTokens: number | null,
  completionTokens: number | null,
  model: string,
  providerId: string,
): number {
  const { input, output } = getPrice(model, providerId);
  const pt = promptTokens ?? 0;
  const ct = completionTokens ?? 0;
  return (pt * input) / 1_000_000 + (ct * output) / 1_000_000;
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
            COALESCE(SUM(completion_tokens), 0) AS ct
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?`,
  ).get(fromTs, toTs) as { pt: number; ct: number };
  const pt = Number(sumRow.pt);
  const ct = Number(sumRow.ct);

  const rows = query(
    `SELECT prompt_tokens, completion_tokens, model, provider_id
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
        AND (prompt_tokens IS NOT NULL OR completion_tokens IS NOT NULL)`,
  ).all(fromTs, toTs) as Record<string, unknown>[];
  const cost = rows.reduce(
    (s, r) =>
      s +
      computeCost(
        r.prompt_tokens as number | null,
        r.completion_tokens as number | null,
        String(r.model),
        String(r.provider_id),
      ),
    0,
  );

  return { totalTokens: pt + ct, inputTokens: pt, outputTokens: ct, cost };
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
  const success = counts.get("success") ?? 0;
  const error = counts.get("error") ?? 0;
  const errRows = query(
    `SELECT error_message, COUNT(*) AS c
       FROM request_logs
      WHERE created_at >= ? AND created_at < ?
        AND error_message IS NOT NULL
      GROUP BY error_message ORDER BY c DESC LIMIT 5`,
  ).all(fromTs, toTs) as { error_message: string; c: number }[];
  return {
    success,
    error,
    total: success + error,
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
  const map = new Map<string, number>();
  for (const r of rows) {
    const dt = r.dt as string;
    map.set(
      dt,
      (map.get(dt) ?? 0) +
        computeCost(
          r.prompt_tokens as number | null,
          r.completion_tokens as number | null,
          String(r.model),
          String(r.provider_id),
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
  const map = new Map<string, number>();
  for (const r of rows) {
    const grp = String(r.grp);
    map.set(
      grp,
      (map.get(grp) ?? 0) +
        computeCost(
          r.prompt_tokens as number | null,
          r.completion_tokens as number | null,
          String(r.model),
          String(r.provider_id),
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
    range,
    metric,
    dimension,
  };
}
```

- [ ] **Step 4: Run the full test file**

Run: `bun test app/.server/usage.test.ts`
Expected: ALL PASS (existing summary/time-series/breakdown tests must stay green with the 3 extra error rows — they have NULL tokens so token/cost sums are unchanged; the breakdown `openai` group stays 4500).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add app/.server/usage.ts app/.server/usage.test.ts
git commit -m "feat: usage data layer adds performance, trends, errors"
```

---

### Task 2: `StatCard` delta + subline props

**Files:**
- Modify: `app/components/ui/stat-card.tsx` (full rewrite below)

**Interfaces:**
- Consumes: nothing new
- Produces (used by Task 6):
  - New optional props: `delta?: { value: number | null; good: boolean }`, `deltaSuffix?: string` (default `"%"`), `subline?: string`
  - Existing props unchanged: `title`, `value`, `suffix`, `accent`, `icon` — existing call sites in `home.tsx` and `api-manager._index.tsx` must render identically.

- [ ] **Step 1: Rewrite `app/components/ui/stat-card.tsx`**

Replace the entire file with:

```tsx
import type { ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";

export function StatCard({
  title,
  value,
  suffix,
  accent = "bg-primary",
  icon,
  delta,
  deltaSuffix = "%",
  subline,
}: {
  title: string;
  value: string | number;
  suffix?: string;
  accent?: string;
  icon?: ReactNode;
  delta?: { value: number | null; good: boolean };
  deltaSuffix?: string;
  subline?: string;
}) {
  const isUp = delta?.value == null ? null : delta.value >= 0;
  const isFlat = delta?.value === 0;
  const tone =
    isUp == null || isFlat
      ? "text-muted-foreground"
      : isUp === delta!.good
        ? "text-success"
        : "text-danger";

  return (
    <div className="glass-panel p-5 transition hover:-translate-y-0.5 hover:border-primary/30">
      <div className="mb-3 flex items-center justify-between">
        <div className={`h-1 w-10 rounded-full ${accent}`} />
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
        {value}
        {suffix ? <span className="ml-1 text-sm font-medium text-muted-foreground">{suffix}</span> : null}
      </p>
      {delta ? (
        <p className={`mt-1.5 flex items-center gap-1 text-xs font-medium tabular-nums ${tone}`}>
          {isUp == null ? (
            <span>—</span>
          ) : isFlat ? (
            <span>0{deltaSuffix}</span>
          ) : (
            <>
              {isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
              <span>
                {delta.value >= 0 ? "+" : ""}
                {delta.value}
                {deltaSuffix}
              </span>
            </>
          )}
        </p>
      ) : null}
      {subline ? <p className="mt-1 text-xs text-muted-foreground">{subline}</p> : null}
    </div>
  );
}
```

- [ ] **Step 2: Verify shared-component safety**

Run: `npm run typecheck`
Expected: no errors — `home.tsx` / `api-manager._index.tsx` usages pass only the existing props.

- [ ] **Step 3: Commit**

```bash
git add app/components/ui/stat-card.tsx
git commit -m "feat: StatCard delta badge and subline props"
```

---

### Task 3: CSS bar-grow keyframes

**Files:**
- Modify: `app/app.css`

**Interfaces:**
- Consumes: nothing
- Produces (used by Tasks 4-5): `.bar-grow-y` and `.bar-grow-x` CSS classes with `animation-delay` applied inline via `style`.

- [ ] **Step 1: Add the keyframes**

Insert this block immediately after the `.dialog-pop[open]::backdrop` rule (after line 258), before the existing `@media (prefers-reduced-motion: reduce)` block:

```css
/* Usage chart bar grow-in (transform-only, compositor-friendly) */
@keyframes grow-y {
  from {
    transform: scaleY(0);
  }
  to {
    transform: scaleY(1);
  }
}
@keyframes grow-x {
  from {
    transform: scaleX(0);
  }
  to {
    transform: scaleX(1);
  }
}
.bar-grow-y {
  transform-origin: bottom;
  animation: grow-y 0.45s ease-out both;
}
.bar-grow-x {
  transform-origin: left;
  animation: grow-x 0.45s ease-out both;
}
```

The existing global reduced-motion rule (lines 260-267) already zeroes out animation durations for these classes — no additional guard needed.

- [ ] **Step 2: Commit**

```bash
git add app/app.css
git commit -m "feat: bar grow-in keyframes for usage charts"
```

---

### Task 4: Rewrite `app/components/usage/time-series-chart.tsx`

**Files:**
- Modify: `app/components/usage/time-series-chart.tsx` (full rewrite below)

**Interfaces:**
- Consumes: `Metric`, `TimeSeriesPoint` from `../../.server/usage`
- Produces (used by Task 6): `TimeSeriesChart({ data, metric, barHeight? })` — identical exported signature plus optional `barHeight`.

- [ ] **Step 1: Rewrite the component**

Replace the entire file with:

```tsx
import type { Metric, TimeSeriesPoint } from "../../.server/usage";

type Props = {
  data: TimeSeriesPoint[];
  metric: Metric;
  barHeight?: number;
};

function fmtValue(value: number, metric: Metric): string {
  if (metric === "cost") return `$${value.toFixed(2)}`;
  return value.toLocaleString();
}

export function TimeSeriesChart({ data, metric, barHeight = 160 }: Props) {
  if (data.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No data for this period
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.value));
  const fill = metric === "cost" ? "bg-success" : "bg-primary";

  return (
    <div className="w-full overflow-x-auto" role="img" aria-label={`${metric} time series`}>
      <div className="flex items-end gap-1.5" style={{ minWidth: `${data.length * 32}px` }}>
        {data.map((d, i) => {
          const h = d.value > 0 ? Math.max(3, (d.value / max) * barHeight) : 3;
          return (
            <div
              key={`${d.labelFull}-${i}`}
              className="flex flex-1 flex-col items-center gap-1"
              title={`${d.labelFull}: ${fmtValue(d.value, metric)}`}
            >
              <span className="hidden text-[10px] leading-none tabular-nums text-muted-foreground sm:block">
                {fmtValue(d.value, metric)}
              </span>
              <div className="flex w-full items-end" style={{ height: barHeight }}>
                <div
                  className={`bar-grow-y w-full rounded-sm ${d.value > 0 ? fill : "bg-[#4b5563]"}`}
                  style={{ height: `${h}px`, animationDelay: `${i * 25}ms` }}
                />
              </div>
              <span className="text-[10px] leading-none text-muted-foreground">{d.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/usage/time-series-chart.tsx
git commit -m "feat: responsive HTML/CSS time-series chart"
```

---

### Task 5: Rewrite `app/components/usage/breakdown-chart.tsx`

**Files:**
- Modify: `app/components/usage/breakdown-chart.tsx` (full rewrite below)

**Interfaces:**
- Consumes: `BreakdownEntry`, `Metric` from `../../.server/usage`
- Produces (used by Task 6): `BreakdownChart({ data, metric })` — unchanged signature.

- [ ] **Step 1: Rewrite the component**

Replace the entire file with:

```tsx
import type { BreakdownEntry, Metric } from "../../.server/usage";

type Props = {
  data: BreakdownEntry[];
  metric: Metric;
};

function fmtValue(value: number, metric: Metric): string {
  if (metric === "cost") return `$${value.toFixed(2)}`;
  return `${value.toLocaleString()} tokens`;
}

function truncate(name: string, n = 28): string {
  return name.length > n ? name.slice(0, n - 1) + "…" : name;
}

export function BreakdownChart({ data, metric }: Props) {
  if (data.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No data for this period
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.value));

  return (
    <div role="img" aria-label={`${metric} breakdown`}>
      <ul className="space-y-3">
        {data.map((d, i) => {
          const pctW = Math.round((d.value / max) * 100);
          const fill =
            d.name === "Other" ? "bg-[#6b7280]" : i % 2 === 0 ? "bg-primary" : "bg-primary/70";
          return (
            <li key={`${d.name}-${i}`} className="flex flex-col gap-1 md:flex-row md:items-center md:gap-3">
              <div className="flex items-center justify-between gap-2 md:w-40 md:shrink-0">
                <span className="truncate text-sm text-muted-foreground" title={d.name}>
                  {truncate(d.name)}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground md:hidden">
                  {fmtValue(d.value, metric)}
                </span>
              </div>
              <div className="flex flex-1 items-center gap-2">
                <div className="h-4 flex-1 overflow-hidden rounded-sm bg-white/5">
                  <div
                    className={`bar-grow-x h-full ${fill}`}
                    style={{ width: `${pctW}%`, animationDelay: `${i * 25}ms` }}
                    title={`${d.name}: ${fmtValue(d.value, metric)}`}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {d.pct}%
                </span>
                <span className="hidden w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground md:block">
                  {fmtValue(d.value, metric)}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
```

Mobile layout: label row (name left, value right), bar row (bar + pct). Desktop (`md:`+): label | bar + pct + value on one line. No clipping.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/usage/breakdown-chart.tsx
git commit -m "feat: responsive HTML/CSS breakdown chart"
```

---

### Task 6: Rewrite `app/routes/analytics.usage.tsx`

**Files:**
- Modify: `app/routes/analytics.usage.tsx` (full rewrite below)

**Interfaces:**
- Consumes: `getUsageData` + types from `../.server/usage` (Task 1); `TimeSeriesChart` (Task 4); `BreakdownChart` (Task 5); `StatCard` with `delta`/`deltaSuffix`/`subline` (Task 2); UI kit.

- [ ] **Step 1: Write the page**

Replace the entire file with:

```tsx
import { useSearchParams } from "react-router";
import type { Route } from "./+types/analytics.usage";
import { TrendingUp } from "lucide-react";
import {
  getUsageData,
  type Dimension,
  type Metric,
  type TimeRange,
} from "../.server/usage";
import { TimeSeriesChart } from "../components/usage/time-series-chart";
import { BreakdownChart } from "../components/usage/breakdown-chart";
import { PageHeader } from "../components/ui/page-header";
import { StatCard } from "../components/ui/stat-card";
import { Tabs } from "../components/ui/tabs";
import { Card, CardHeader, CardTitle } from "../components/ui/card";

export function meta() {
  return [{ title: "Usage — UniRoute" }];
}

const RANGES: TimeRange[] = ["day", "week", "month", "year", "all"];
const METRICS: Metric[] = ["tokens", "cost"];
const DIMENSIONS: Dimension[] = ["provider", "model", "apikey"];

const RANGE_LABEL: Record<TimeRange, string> = {
  day: "Day",
  week: "Week",
  month: "Month",
  year: "Year",
  all: "All",
};

const DIMENSION_LABEL: Record<Dimension, string> = {
  provider: "Provider",
  model: "Model",
  apikey: "API Key",
};

function parseParam<T extends string>(raw: string | null, allowed: T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

export function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const range = parseParam<TimeRange>(url.searchParams.get("range"), RANGES, "month");
  const metric = parseParam<Metric>(url.searchParams.get("metric"), METRICS, "tokens");
  const dimension = parseParam<Dimension>(url.searchParams.get("dimension"), DIMENSIONS, "provider");
  return getUsageData({ range, metric, dimension });
}

function rangeTitle(range: TimeRange): string {
  const now = new Date();
  switch (range) {
    case "day":
      return now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    case "week":
      return `Week of ${now.toLocaleDateString(undefined, { month: "long", day: "numeric" })}`;
    case "month":
      return now.toLocaleDateString(undefined, { year: "numeric", month: "long" });
    case "year":
      return String(now.getFullYear());
    case "all":
      return "All time";
  }
}

function fmtTokens(n: number): string {
  return n > 0 ? n.toLocaleString() : "—";
}

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(2)}` : "—";
}

function shortError(msg: string, max = 60): string {
  let text = msg;
  try {
    const parsed = JSON.parse(msg) as { error?: { message?: string }; message?: string };
    text = parsed?.error?.message ?? parsed?.message ?? msg;
  } catch {
    /* not JSON — use raw text */
  }
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

function deltaProps(
  value: number | null,
  good: boolean,
  suffix = "%",
): { value: number | null; good: boolean; deltaSuffix: string } {
  return { value, good, deltaSuffix: suffix };
}

function useUsageParams() {
  const [, setSearchParams] = useSearchParams();
  return {
    setRange: (r: TimeRange) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("range", r);
        return next;
      }),
    setMetric: (m: Metric) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("metric", m);
        return next;
      }),
    setDimension: (d: Dimension) =>
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set("dimension", d);
        return next;
      }),
  };
}

export default function AnalyticsUsage({ loaderData }: Route.ComponentProps) {
  const { summary, performance, trends, errors, timeSeries, breakdown, range, metric, dimension } =
    loaderData;
  const { setRange, setMetric, setDimension } = useUsageParams();

  const errTotal = errors.total || 1;
  const successPct = errors.total ? Math.round((errors.success / errors.total) * 100) : 0;
  const errorPct = errors.total ? Math.round((errors.error / errors.total) * 100) : 0;

  return (
    <div>
      <PageHeader
        title="Usage"
        icon={<TrendingUp size={20} />}
        subtitle={`${RANGE_LABEL[range]} — ${rangeTitle(range)}`}
        actions={
          <Tabs
            tabs={RANGES.map((r) => RANGE_LABEL[r])}
            active={RANGE_LABEL[range]}
            onChange={(label) => {
              const r = RANGES.find((x) => RANGE_LABEL[x] === label)!;
              setRange(r);
            }}
          />
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Tokens"
          value={fmtTokens(summary.totalTokens)}
          delta={deltaProps(trends.totalTokens, true)}
        />
        <StatCard
          title="Input Tokens"
          value={fmtTokens(summary.inputTokens)}
          accent="bg-info"
          delta={deltaProps(trends.inputTokens, true)}
        />
        <StatCard
          title="Output Tokens"
          value={fmtTokens(summary.outputTokens)}
          accent="bg-warning"
          delta={deltaProps(trends.outputTokens, true)}
        />
        <StatCard
          title="Est. Cost"
          value={fmtCost(summary.cost)}
          accent="bg-success"
          delta={deltaProps(trends.cost, false)}
          subline={`Avg cost / request: ${fmtCost(performance.costPerReq)}`}
        />
        <StatCard
          title="Requests"
          value={fmtTokens(performance.requests)}
          delta={deltaProps(trends.requests, true)}
        />
        <StatCard
          title="Success Rate"
          value={fmtTokens(performance.successRate)}
          suffix="%"
          accent="bg-success"
          delta={deltaProps(trends.successRate, true, " pts")}
        />
        <StatCard
          title="Avg Latency"
          value={fmtTokens(performance.avgLatencyMs)}
          suffix="ms"
          accent="bg-warning"
          delta={deltaProps(trends.avgLatencyMs, false)}
        />
        <StatCard
          title="Avg Tokens / Req"
          value={fmtTokens(Math.round(performance.tokensPerReq))}
          accent="bg-info"
          delta={deltaProps(trends.tokensPerReq, true)}
        />
      </div>

      <Card className="mb-6">
        <CardHeader className="flex-wrap">
          <CardTitle>
            {metric === "tokens" ? "Tokens" : "Cost"} — {DIMENSION_LABEL[dimension]} — {rangeTitle(range)}
          </CardTitle>
          <Tabs
            tabs={METRICS.map((m) => (m === "tokens" ? "Tokens" : "Cost"))}
            active={metric === "tokens" ? "Tokens" : "Cost"}
            onChange={(label) => {
              const m = label === "Cost" ? "cost" : "tokens";
              setMetric(m);
            }}
          />
        </CardHeader>
        <TimeSeriesChart data={timeSeries} metric={metric} />
        <div className="mt-3 border-t border-glass-border pt-3">
          <Tabs
            tabs={DIMENSIONS.map((d) => DIMENSION_LABEL[d])}
            active={DIMENSION_LABEL[dimension]}
            onChange={(label) => {
              const d = DIMENSIONS.find((x) => DIMENSION_LABEL[x] === label)!;
              setDimension(d);
            }}
          />
        </div>
      </Card>

      <Card className="mb-6">
        <CardHeader className="flex-wrap">
          <CardTitle>Top {breakdown.length || 10} — {DIMENSION_LABEL[dimension]}</CardTitle>
          <div className="flex items-center gap-2">
            <Tabs
              tabs={METRICS.map((m) => (m === "tokens" ? "Tokens" : "Cost"))}
              active={metric === "tokens" ? "Tokens" : "Cost"}
              onChange={(label) => {
                const m = label === "Cost" ? "cost" : "tokens";
                setMetric(m);
              }}
            />
            <span className="text-xs text-muted-foreground">·</span>
            <Tabs
              tabs={DIMENSIONS.map((d) => DIMENSION_LABEL[d])}
              active={DIMENSION_LABEL[dimension]}
              onChange={(label) => {
                const d = DIMENSIONS.find((x) => DIMENSION_LABEL[x] === label)!;
                setDimension(d);
              }}
            />
          </div>
        </CardHeader>
        <BreakdownChart data={breakdown} metric={metric} />
      </Card>

      <Card>
        <CardHeader className="flex-wrap">
          <CardTitle>Status &amp; Errors</CardTitle>
        </CardHeader>
        <div className="space-y-5">
          <div>
            <div
              className="flex h-4 w-full overflow-hidden rounded-full bg-white/5"
              role="img"
              aria-label={`${errors.success} success, ${errors.error} errors`}
            >
              {errors.success > 0 ? (
                <div className="bg-success" style={{ width: `${(errors.success / errTotal) * 100}%` }} />
              ) : null}
              {errors.error > 0 ? (
                <div className="bg-danger" style={{ width: `${(errors.error / errTotal) * 100}%` }} />
              ) : null}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-success" />
                {errors.success} success ({successPct}%)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-danger" />
                {errors.error} error ({errorPct}%)
              </span>
            </div>
          </div>

          {errors.top.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-foreground">Top errors</h3>
              <ul className="space-y-1.5">
                {errors.top.map((e, i) => (
                  <li key={`${e.message}-${i}`} className="flex items-center gap-2 text-sm">
                    <code title={e.message} className="flex-1 truncate text-xs text-muted-foreground">
                      {shortError(e.message)}
                    </code>
                    <span className="shrink-0 rounded-full bg-white/5 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                      {e.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No errors in this period</p>
          )}

          <div className="border-t border-glass-border pt-3 text-xs text-muted-foreground">
            Avg cost / request: <span className="tabular-nums">{fmtCost(performance.costPerReq)}</span> · Avg
            tokens / request: <span className="tabular-nums">{fmtTokens(Math.round(performance.tokensPerReq))}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all tests pass (including new `usage.test.ts` suites).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual smoke test**

Run: `npm run dev` and open `/analytics/usage`.

Desktop (≥1024px):
- 8 stat cards across 2 rows; each shows a delta badge (▲/▼/—) with the correct color (cost/latency red when up, green when down; success rate green when up).
- Time-series and breakdown cards render HTML bars that grow in staggered.
- Status & Errors card: segmented bar + legend, top errors list (rate-limit/model-not-found messages from real DB), efficiency line.

Mobile (~375px viewport):
- Stat cards stack 1-column.
- Time-series chart scrolls horizontally when many buckets; value labels hidden, `title` tooltip on bars.
- Breakdown rows restack: name+value on line 1, bar+pct on line 2 — nothing clips off-screen.
- Card headers wrap instead of overflowing.

- [ ] **Step 6: Commit**

```bash
git add app/routes/analytics.usage.tsx
git commit -m "feat: usage page performance cards, trends, and status/errors section"
```

---

### Task 7: Final verification

- [ ] **Step 1: Full check**

Run:
```bash
npm run typecheck
npm test
npm run build
```

- [ ] **Step 2: Confirm spec adherence**

Verify `docs/superpowers/specs/2026-08-18-usage-page-enhancement-design.md` matches the implementation. One intentional deviation to note in the commit message if needed: mobile breakdown shows the value on the label line (name+value together) with pct beside the bar, rather than pct+value both beside the bar — visually cleaner, still nothing clips. Update the spec only if the deviation is significant.

- [ ] **Step 3: Commit any stragglers**

```bash
git status
git add -A
git commit -m "chore: usage page enhancement final cleanup" || echo "nothing to commit"
```

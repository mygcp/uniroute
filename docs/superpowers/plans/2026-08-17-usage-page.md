# Usage Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full-featured Usage page at `/analytics/usage` with summary cards (total/input/output tokens, est. cost), a time-series chart, and a breakdown chart, filtered by Day/Week/Month/Year/All (default Month).

**Architecture:** A new server module `app/.server/usage.ts` queries `request_logs` (ms `created_at`, normalized by `/1000` in SQL) and computes cost per row via `pricing.getPrice`. The route loader parses `range`/`metric`/`dimension` from URL search params and returns one `UsageData` object. Two hand-rolled SVG chart components render the time series and breakdown. No new runtime dependencies.

**Tech Stack:** React Router v8 (loader + search params), TypeScript, SQLite (bun:sqlite/node:sqlite via `db.ts`), hand-rolled SVG, existing glass UI kit (`Card`, `StatCard`, `Tabs`, `PageHeader`), `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-17-usage-page-design.md`

## Global Constraints

- No new runtime dependencies (no chart lib).
- `request_logs.created_at` is stored in **milliseconds**; all SQL date math must use `created_at / 1000` with `'unixepoch'`.
- Cost is computed per row from `pricing.getPrice(model, providerId)`; never stored.
- Hand-rolled SVG only; `<title>` elements for tooltips.
- Follow existing glass-UI conventions (`glass-panel`, `Tabs`, `StatCard`, `PageHeader`).
- All UI copy in English (existing app mixes, but new page uses English).

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `app/.server/stats.ts` | Modify | Fix ms timestamp bug in `getUsageLast7Days` |
| `app/.server/usage.ts` | Create | Data layer: summary, time series, breakdown queries + cost |
| `app/.server/usage.test.ts` | Create | Unit tests for the data layer |
| `app/components/usage/time-series-chart.tsx` | Create | SVG bar chart for time series |
| `app/components/usage/breakdown-chart.tsx` | Create | SVG horizontal bar chart for breakdown |
| `app/routes/analytics.usage.tsx` | Rewrite | Page: loader, tabs, cards, charts |

---

### Task 1: Fix timestamp bug in `stats.ts`

**Files:**
- Modify: `app/.server/stats.ts:27-43` (the `getUsageLast7Days` function)

**Interfaces:**
- Consumes: `query` from `./db`
- Produces: unchanged `getUsageLast7Days(): { day: string; count: number }[]` — but now with correct dates

**Problem:** `request_logs.created_at` is written by `logger.ts` as `Date.now()` (milliseconds). `getUsageLast7Days` currently uses `date(created_at, 'unixepoch')` (expects seconds) and `created_at >= strftime('%s','now','-6 days')` (returns seconds). Both are wrong — dates show 1970s and the WHERE never matches.

- [ ] **Step 1: Fix the SQL in `getUsageLast7Days`**

Replace the query in `getUsageLast7Days` (lines 28-33) with:

```ts
const rows = query(
  `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day, COUNT(*) AS c
   FROM request_logs
   WHERE created_at >= (strftime('%s','now','-6 days') * 1000)
   GROUP BY day ORDER BY day`,
).all() as { day: string; c: number }[];
```

- [ ] **Step 2: Verify the fix**

Run: `bun test app/.server/key-audit.test.ts` (existing suite that touches `request_logs`) — should stay green.

Also run a quick sanity check against the real DB:

```bash
bun -e '
const { Database } = require("bun:sqlite");
const db = new Database("./data/uniroute.db");
const rows = db.query(`SELECT strftime(\"%Y-%m-%d\", created_at / 1000, \"unixepoch\") AS day, COUNT(*) AS c FROM request_logs WHERE created_at >= (strftime(\"%s\",\"now\",\"-6 days\") * 1000) GROUP BY day ORDER BY day`).all();
console.log(rows);
'
```

Expected: recent dates (2026-08-xx), not 1970.

- [ ] **Step 3: Commit**

```bash
git add app/.server/stats.ts
git commit -m "fix: correct ms timestamp handling in getUsageLast7Days"
```

---

### Task 2: Create the data layer `app/.server/usage.ts`

**Files:**
- Create: `app/.server/usage.ts`
- Test: `app/.server/usage.test.ts`

**Interfaces:**
- Consumes: `query` from `./db`; `getPrice` from `./pricing`
- Produces (used by Tasks 3-5):
  - `export type TimeRange = "day" | "week" | "month" | "year" | "all"`
  - `export type Metric = "tokens" | "cost"`
  - `export type Dimension = "provider" | "model" | "apikey"`
  - `export type UsageSummary = { totalTokens: number; inputTokens: number; outputTokens: number; cost: number }`
  - `export type TimeSeriesPoint = { label: string; labelFull: string; value: number }`
  - `export type BreakdownEntry = { name: string; value: number; pct: number }`
  - `export type UsageData = { summary: UsageSummary; timeSeries: TimeSeriesPoint[]; breakdown: BreakdownEntry[]; range: TimeRange; metric: Metric; dimension: Dimension }`
  - `export function getUsageData(opts: { range: TimeRange; metric?: Metric; dimension?: Dimension }): UsageData`

- [ ] **Step 1: Write the failing test**

Create `app/.server/usage.test.ts` using the same pattern as `key-usage.test.ts` (`resetTestDb`, `process.env.DATABASE_URL` temp file):

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-usage-test-${randomUUID()}.db`;

type UsageModule = typeof import("./usage");
type DbModule = typeof import("./db");

let usage: UsageModule;
let db: DbModule;

const DAY_MS = 86_400_000;

function insertLog(row: {
  model: string;
  provider_id: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  api_key_id?: number | null;
  created_at: number; // ms
}): void {
  db.query(
    `INSERT INTO request_logs (model, provider_id, prompt_tokens, completion_tokens, api_key_id, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'success')`,
  ).run(
    row.model,
    row.provider_id,
    row.prompt_tokens ?? null,
    row.completion_tokens ?? null,
    row.api_key_id ?? null,
    row.created_at,
  );
}

beforeAll(async () => {
  await resetTestDb();
  usage = await import("./usage");
  db = await import("./db");
  const now = Date.now();
  insertLog({ model: "gpt-4o", provider_id: "openai", prompt_tokens: 1000, completion_tokens: 500, created_at: now });
  insertLog({ model: "gpt-4o", provider_id: "openai", prompt_tokens: 2000, completion_tokens: 1000, created_at: now - DAY_MS });
  insertLog({ model: "claude-3-5-sonnet", provider_id: "anthropic", prompt_tokens: 500, completion_tokens: 200, created_at: now - 2 * DAY_MS });
  insertLog({ model: "claude-3-5-sonnet", provider_id: "anthropic", prompt_tokens: null, completion_tokens: null, created_at: now - 100 * DAY_MS });
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("getUsageData summary", () => {
  test("aggregates tokens and estimates cost for range=all", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.summary.inputTokens).toBe(3500); // 1000+2000+500
    expect(data.summary.outputTokens).toBe(1700); // 500+1000+200
    expect(data.summary.totalTokens).toBe(5200);
    expect(data.summary.cost).toBeCloseTo(
      (3000 * 2.5 + 1500 * 10 + 500 * 3 + 200 * 15) / 1_000_000,
      6,
    );
  });

  test("range=day only includes today's row", () => {
    const data = usage.getUsageData({ range: "day" });
    expect(data.summary.totalTokens).toBe(1500); // 1000+500
    expect(data.summary.inputTokens).toBe(1000);
    expect(data.summary.outputTokens).toBe(500);
  });
});
```

Expected: FAIL (module `./usage` does not exist).

- [ ] **Step 2: Run the test to confirm it fails**

Run: `bun test app/.server/usage.test.ts`
Expected: error "Cannot find module './usage'" or similar.

- [ ] **Step 3: Implement `app/.server/usage.ts`**

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

function dateExpr(range: TimeRange): string {
  if (range === "day") return `strftime('%Y-%m-%d %H:00', created_at / 1000, 'unixepoch')`;
  if (range === "year" || range === "all") return `strftime('%Y-%m', created_at / 1000, 'unixepoch')`;
  return `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')`;
}

function shortLabel(dt: string, range: TimeRange): string {
  if (range === "day") return dt.slice(11, 16); // "14:00"
  if (range === "year" || range === "all") {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    return months[parseInt(dt.slice(5, 7), 10) - 1];
  }
  const [, mo, day] = dt.split("-");
  return `${parseInt(mo, 10)}/${parseInt(day, 10)}`;
}

function buildGroupCol(dim: Dimension): string {
  switch (dim) {
    case "provider": return "provider_id";
    case "model": return "model";
    case "apikey": return "COALESCE(api_key_id, 0)";
  }
}

function groupLabel(grp: string | number, dim: Dimension): string {
  if (dim === "apikey") return grp === 0 || grp === "0" ? "No API Key" : `Key #${grp}`;
  return String(grp);
}

function _querySummary(range: TimeRange): UsageSummary {
  const [fromTs, toTs] = rangeBounds(range);
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
    map.set(dt, (map.get(dt) ?? 0) + computeCost(
      r.prompt_tokens as number | null,
      r.completion_tokens as number | null,
      String(r.model),
      String(r.provider_id),
    ));
  }
  return Array.from(map.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([dt, value]) => ({ label: shortLabel(dt, range), labelFull: dt, value }));
}

function _formatBreakdown(rows: { grp: string | number; val: number }[], total: number, dim: Dimension): BreakdownEntry[] {
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
    map.set(grp, (map.get(grp) ?? 0) + computeCost(
      r.prompt_tokens as number | null,
      r.completion_tokens as number | null,
      String(r.model),
      String(r.provider_id),
    ));
  }
  const sorted = Array.from(map.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 11);
  const total = sorted.reduce((s, [, v]) => s + v, 0);
  return _formatBreakdown(sorted.map(([grp, val]) => ({ grp, val })), total, dim);
}

export function getUsageData(opts: {
  range: TimeRange;
  metric?: Metric;
  dimension?: Dimension;
}): UsageData {
  const { range } = opts;
  const metric = opts.metric ?? "tokens";
  const dimension = opts.dimension ?? "provider";
  return {
    summary: _querySummary(range),
    timeSeries: _queryTimeSeries(range, metric),
    breakdown: _queryBreakdown(range, metric, dimension),
    range,
    metric,
    dimension,
  };
}
```

- [ ] **Step 4: Add more tests** (append to `usage.test.ts`)

```ts
describe("time series", () => {
  test("range=week returns daily buckets ascending", () => {
    const data = usage.getUsageData({ range: "week", metric: "tokens" });
    const buckets = data.timeSeries;
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets[0].labelFull).toBeLessThanOrEqual(buckets[buckets.length - 1].labelFull);
    for (const b of buckets) {
      expect(typeof b.value).toBe("number");
      expect(b.value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("breakdown", () => {
  test("breakdown by provider aggregates correctly and sums pct to ~100", () => {
    const data = usage.getUsageData({ range: "all", metric: "tokens", dimension: "provider" });
    const byProvider = new Map(data.breakdown.map((b) => [b.name, b.value]));
    expect(byProvider.get("openai")).toBe(4500); // 1000+500 + 2000+1000
    expect(byProvider.get("anthropic")).toBe(700); // 500+200
    const pctSum = data.breakdown.reduce((s, b) => s + b.pct, 0);
    expect(pctSum).toBeLessThanOrEqual(100);
  });

  test("apikey dimension groups null keys as 'No API Key'", () => {
    const data = usage.getUsageData({ range: "all", dimension: "apikey" });
    const names = data.breakdown.map((b) => b.name);
    expect(names).toContain("No API Key");
  });
});
```

- [ ] **Step 5: Run the full test file**

Run: `bun test app/.server/usage.test.ts`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add app/.server/usage.ts app/.server/usage.test.ts
git commit -m "feat: usage data layer (summary, time series, breakdown)"
```

---

### Task 3: Create `app/components/usage/time-series-chart.tsx`

**Files:**
- Create: `app/components/usage/time-series-chart.tsx`

**Interfaces:**
- Consumes: `TimeSeriesPoint`, `Metric` types from `../.server/usage`
- Produces: `TimeSeriesChart` component consumed by Task 5

- [ ] **Step 1: Write the component**

```tsx
import type { Metric, TimeSeriesPoint } from "../../.server/usage";

type Props = {
  data: TimeSeriesPoint[];
  metric: Metric;
  viewBox?: { w: number; h: number };
};

function fmtValue(value: number, metric: Metric): string {
  if (metric === "cost") return `$${value.toFixed(2)}`;
  return value.toLocaleString();
}

export function TimeSeriesChart({ data, metric, viewBox = { w: 900, h: 200 } }: Props) {
  const { w, h } = viewBox;
  const max = Math.max(1, ...data.map((d) => d.value));
  const barGap = 12;
  const barW = data.length > 0 ? (w - barGap * (data.length - 1)) / data.length : w;
  const fill = metric === "cost" ? "#10b981" : "#3b82f6";

  if (data.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No data for this period
      </div>
    );
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`${metric} time series`}>
      <line x1="0" y1={h - 20} x2={w} y2={h - 20} stroke="#4b5563" />
      {data.map((d, i) => {
        const x = i * (barW + barGap);
        const bh = d.value > 0 ? Math.max(1, (d.value / max) * (h - 40)) : 0;
        return (
          <g key={`${d.labelFull}-${i}`}>
            <rect
              x={x}
              y={h - 20 - bh}
              width={barW}
              height={bh}
              rx={3}
              fill={d.value > 0 ? fill : "#4b5563"}
            >
              <title>{`${d.labelFull}: ${fmtValue(d.value, metric)}`}</title>
            </rect>
            {bh > 5 ? (
              <text x={x + barW / 2} y={h - 26 - bh} textAnchor="middle" fontSize="9" fill="#9ca3af" className="tabular-nums">
                {fmtValue(d.value, metric)}
              </text>
            ) : null}
            <text x={x + barW / 2} y={h - 6} textAnchor="middle" fontSize="9" fill="#9ca3af">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit app/components/usage/time-series-chart.tsx`
Expected: no type errors (or run `npm run typecheck` once Task 5 exists).

- [ ] **Step 3: Commit**

```bash
git add app/components/usage/time-series-chart.tsx
git commit -m "feat: SVG time-series usage chart"
```

---

### Task 4: Create `app/components/usage/breakdown-chart.tsx`

**Files:**
- Create: `app/components/usage/breakdown-chart.tsx`

**Interfaces:**
- Consumes: `BreakdownEntry`, `Metric` types from `../.server/usage`
- Produces: `BreakdownChart` component consumed by Task 5

- [ ] **Step 1: Write the component**

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

function truncate(name: string, n = 20): string {
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
  const rowH = 44;
  const headerH = 20;
  const h = Math.max(80, data.length * rowH + headerH);
  const w = 800;
  const barMaxW = w * 0.6;
  const barX = 200;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`${metric} breakdown`}>
      {data.map((d, i) => {
        const y = headerH + i * rowH;
        const bw = (d.value / max) * barMaxW;
        const fill = d.name === "Other" ? "#6b7280" : i % 2 === 0 ? "#3b82f6" : "#2563eb";
        return (
          <g key={`${d.name}-${i}`}>
            <text x={barX - 8} y={y + 14} textAnchor="end" fontSize="12" fill="#9ca3af">
              <title>{d.name}</title>
              {truncate(d.name)}
            </text>
            <rect x={barX} y={y + 2} width={Math.max(0, bw)} height={16} rx={3} fill={fill}>
              <title>{`${d.name}: ${fmtValue(d.value, metric)}`}</title>
            </rect>
            {bw > 40 ? (
              <text x={barX + bw - 6} y={y + 14} textAnchor="end" fontSize="11" fill="#fff">
                {d.pct}%
              </text>
            ) : (
              <text x={barX + bw + 4} y={y + 14} fontSize="11" fill="#9ca3af">
                {d.pct}%
              </text>
            )}
            <text x={barX + barMaxW + 12} y={y + 14} fontSize="11" fill="#9ca3af" className="tabular-nums">
              {fmtValue(d.value, metric)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit app/components/usage/breakdown-chart.tsx`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add app/components/usage/breakdown-chart.tsx
git commit -m "feat: SVG breakdown usage chart"
```

---

### Task 5: Rewrite `app/routes/analytics.usage.tsx`

**Files:**
- Modify: `app/routes/analytics.usage.tsx` (full rewrite)

**Interfaces:**
- Consumes: `getUsageData`, `type TimeRange`, `type Metric`, `type Dimension` from `../.server/usage`; `TimeSeriesChart` from `../components/usage/time-series-chart`; `BreakdownChart` from `../components/usage/breakdown-chart`; UI kit components (`StatCard`, `PageHeader`, `Tabs`, `Card`, `CardHeader`, `CardTitle`)

- [ ] **Step 1: Write the page**

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

function useUsageParams() {
  const [searchParams, setSearchParams] = useSearchParams();
  return {
    searchParams,
    setRange: (r: TimeRange) => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set("range", r); return next; }),
    setMetric: (m: Metric) => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set("metric", m); return next; }),
    setDimension: (d: Dimension) => setSearchParams((prev) => { const next = new URLSearchParams(prev); next.set("dimension", d); return next; }),
  };
}

export default function AnalyticsUsage({ loaderData }: Route.ComponentProps) {
  const { summary, timeSeries, breakdown, range, metric, dimension } = loaderData;
  const { setRange, setMetric, setDimension } = useUsageParams();

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
        <StatCard title="Total Tokens" value={fmtTokens(summary.totalTokens)} />
        <StatCard title="Input Tokens" value={fmtTokens(summary.inputTokens)} accent="bg-info" />
        <StatCard title="Output Tokens" value={fmtTokens(summary.outputTokens)} accent="bg-warning" />
        <StatCard title="Est. Cost" value={fmtCost(summary.cost)} accent="bg-success" />
      </div>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>
            {metric === "tokens" ? "Tokens" : "Cost"} — {RANGE_LABEL[dimension]} — {rangeTitle(range)}
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
            tabs={DIMENSIONS.map((d) => d === "apikey" ? "API Key" : d === "provider" ? "Provider" : "Model")}
            active={dimension === "apikey" ? "API Key" : dimension === "provider" ? "Provider" : "Model"}
            onChange={(label) => {
              const d = label === "API Key" ? "apikey" : label.toLowerCase() as Dimension;
              setDimension(d);
            }}
          />
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Top {breakdown.length || 10} — {RANGE_LABEL[dimension]}</CardTitle>
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
              tabs={DIMENSIONS.map((d) => d === "apikey" ? "API Key" : d === "provider" ? "Provider" : "Model")}
              active={dimension === "apikey" ? "API Key" : dimension === "provider" ? "Provider" : "Model"}
              onChange={(label) => {
                const d = label === "API Key" ? "apikey" : label.toLowerCase() as Dimension;
                setDimension(d);
              }}
            />
          </div>
        </CardHeader>
        <BreakdownChart data={breakdown} metric={metric} />
      </Card>
    </div>
  );
}
```

**Note:** `setSearchParams` triggers client-side navigation; React Router re-runs the loader server-side because the loader reads `request.url` search params. No full page reload.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: all tests pass (including new `usage.test.ts`).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual smoke test**

Run: `bun server.ts` (or `npm run dev`) and open `/analytics/usage`.
- Verify default is Month.
- Switch Day/Week/Year/All → chart buckets change and URL updates.
- Toggle Tokens/Cost and Provider/Model/API Key on both charts.
- Confirm stat cards show total/input/output tokens and est. cost.
- Confirm empty state shows "No data for this period" when no logs in range.

- [ ] **Step 6: Commit**

```bash
git add app/routes/analytics.usage.tsx
git commit -m "feat: usage page with summary cards, time-series and breakdown charts"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full check**

Run:
```bash
npm run typecheck
npm test
npm run build
```

- [ ] **Step 2: Update design doc status if needed**

No code changes expected here; verify `docs/superpowers/specs/2026-08-17-usage-page-design.md` still matches implementation. If anything diverged, note it in a commit message rather than editing the spec (spec is the contract).

- [ ] **Step 3: Commit any stragglers**

```bash
git status
git add -A
git commit -m "chore: usage page final cleanup" || echo "nothing to commit"
```

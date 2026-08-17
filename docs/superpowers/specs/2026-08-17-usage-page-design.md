# Usage Page — Design Spec

**Date:** 2026-08-17
**Status:** Approved
**Author:** design (brainstorming session 2026-08-17)

---

## 1. Goal

Replace the existing stub `analytics.usage.tsx` (which shows a static 7-day bar chart by request count) with a full-featured **Usage** page under `/analytics/usage` that provides:

- Summary stat cards: Total Tokens, Input Tokens, Output Tokens, Est. Cost
- A time-series bar chart showing the selected metric over the selected time range
- A breakdown bar chart showing top-N providers/models/api-keys by the selected metric
- Time range filters: Day / Week / Month / Year / All (default: **Month**)
- Dimension toggles for both charts: Tokens (default) / Cost
- Secondary dimension toggle: Provider (default) / Model / API Key

---

## 2. Non-Goals

- No request-count charts (only tokens and cost)
- No new runtime dependencies — hand-rolled SVG only (matches existing `UsageChart` pattern)
- No export / CSV (out of scope)
- No interactive tooltips (static SVG bars with `<title>` elements)
- No server-side caching beyond normal React Router loader caching

---

## 3. Data Source

All data is queried from `request_logs` in SQLite. No changes to existing tables.

**Why `request_logs` instead of `key_usage_daily`?** `key_usage_daily` has very sparse data (one row for key_id=16, all others empty). `request_logs` has 203+ rows with `model`, `provider_id`, `prompt_tokens`, `completion_tokens`, `created_at` (milliseconds). `api_key_id` is frequently NULL (unauthenticated traffic), so API Key breakdowns will be sparse — show only rows with a non-null `api_key_id`.

**Cost calculation:** Use the existing `pricing.ts` module — call `getPrice(model, providerId)` for each row to get input/output per-MTok prices, then compute:

```
cost = (prompt_tokens ?? 0) * (input_per_mtok / 1_000_000) + (completion_tokens ?? 0) * (output_per_mtok / 1_000_000)
```

If `prompt_tokens` is null on every row (common in this dataset), cost will be 0 — display `$—` for that case and show a subtle note "Cost estimated for rows with prompt token data."

**Time range:** All SQL queries include a WHERE clause on `created_at / 1000` (convert ms → seconds for SQLite `strftime`). The existing `getUsageLast7Days` in `stats.ts` has this bug — it uses `date(created_at, 'unixepoch')` directly, but `created_at` is ms. The new module will use `created_at / 1000`.

**Date bucket key:** SQLite `strftime('%Y-%m-%d', created_at / 1000, 'unixepoch')`.

**Calendar-based ranges:**

| Range   | Start                         | SQL `strftime` bucket |
|---------|-------------------------------|----------------------|
| Day     | Today 00:00 UTC               | Hour (`%H`)          |
| Week    | Most-recent Monday 00:00 UTC  | Day (`%Y-%m-%d`)     |
| Month   | 1st of current month 00:00 UTC | Day (`%Y-%m-%d`)     |
| Year    | Jan 1st current year 00:00 UTC| Month (`%Y-%m`)      |
| All     | First record 00:00 UTC        | Month (`%Y-%m`)      |

---

## 4. Page Layout

```
┌─ /analytics/usage ──────────────────────────────────────────────────────────┐
│                                                                               │
│  PageHeader "Usage"  [Day] [Week] [Month✓] [Year] [All]   ← time range tabs   │
│                                                                               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐             │
│  │ Total Tokens│ │Input Tokens │ │Output Tokens│ │ Est. Cost   │             │
│  │   1,234,567  │ │   987,654   │ │   246,913   │ │   $12.34    │             │
│  └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘             │
│                                                                               │
│  Time-Series Chart ───────────────────────────────────  [Tokens] [Cost]     │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓  ▓▓    │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                          Provider ✓  Model   API Key           │
│                                                                               │
│  Breakdown ─────────────────────────────── [Tokens] [Cost]   [Provider✓] ... │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │  openrouter  ████████████████████████████  40%  987,654 tokens      │    │
│  │  grokai      ████████████████████          30%  740,000 tokens      │    │
│  │  dahl        ██████████████               20%  493,000 tokens      │    │
│  │  other       ████████                      10%  246,000 tokens      │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **PageHeader** (existing component) with `actions` slot hosting the time range Tabs
- **Stat cards row**: 4 StatCard components side-by-side (grid: sm:grid-cols-2 lg:grid-cols-4)
- **Time-Series section**: glass-panel Card with Tabs (metric) above it, Tabs (dimension) below it
- **Breakdown section**: glass-panel Card with Tabs (metric) + Tabs (dimension) in the header

---

## 5. Server Loader

`analytics.usage.tsx` loader function:

```ts
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const range = (url.searchParams.get("range") ?? "month") as TimeRange;
  const metric = (url.searchParams.get("metric") ?? "tokens") as Metric;
  const dimension = (url.searchParams.get("dimension") ?? "provider") as Dimension;

  return getUsageData({ range, metric, dimension });
}
```

- `TimeRange` = `"day" | "week" | "month" | "year" | "all"`
- `Metric` = `"tokens" | "cost"`
- `Dimension` = `"provider" | "model" | "apikey"`

**No client-side fetch on tab change** — tabs change URL params (via `<Form method="get">` or `<Link>`), React Router re-calls the loader server-side. This matches the existing patterns in the app.

If an invalid param is passed, default to: range=month, metric=tokens, dimension=provider.

---

## 6. Stat Cards (4 cards)

| # | Title          | Value source                                        | Suffix   |
|---|----------------|-----------------------------------------------------|----------|
| 1 | Total Tokens   | SUM(prompt_tokens + completion_tokens)               | none     |
| 2 | Input Tokens   | SUM(prompt_tokens)                                  | none     |
| 3 | Output Tokens  | SUM(completion_tokens)                               | none     |
| 4 | Est. Cost      | SUM(computed cost)                                  | `$` prefix |
|   |                |                                                     |          |

All values formatted with `toLocaleString()` (e.g., `1,234,567`). For Total/Input/Output, use `.toLocaleString()`. For Cost, use `$${value.toFixed(2)}` (2 decimal places).

If there is no data for a stat, display `—` (em dash).

Cards use the existing `StatCard` component. Accent colors: Total=bg-primary, Input=bg-info, Output=bg-warning, Cost=bg-success.

---

## 7. Time-Series Chart

**Container:** `glass-panel Card` (existing component), padded, with `mb-6`.

**Metric Tabs** (above chart): `"Tokens"` | `"Cost"` — rendered using the existing `Tabs` component. Default: `"Tokens"`.

**Chart dimensions:** Width 100% of container (max ~900px SVG viewBox 900×200), height 200.

**Bucket logic:**

| Range | Bucket SQL                                     | X-axis label (short) | X-axis label (full) |
|-------|------------------------------------------------|----------------------|---------------------|
| Day   | `strftime('%Y-%m-%d %H:00', ts)`               | "10:00" (every 2h)  | full timestamp      |
| Week  | `strftime('%Y-%m-%d', ts)`                     | "Mon", "Tue"...      | full date           |
| Month | `strftime('%Y-%m-%d', ts)`                     | "Aug 1", "Aug 8"... | full date           |
| Year  | `strftime('%Y-%m', ts)`                        | "Jan", "Feb"...      | "2026 Jan"          |
| All   | `strftime('%Y-%m', ts)`                        | "Jan", "Feb"...      | "2026 Jan"          |

**Bar fill colors:**
- Tokens: `#3b82f6` (blue — existing primary)
- Cost: `#10b981` (emerald green)

**Zero-value bars:** `#4b5563` (existing gray).

**Grid line:** horizontal line at bottom (y = 200 - 20), color `#4b5563`.

**Y-axis:** implicit (bars scale to max). Value label above each bar if space permits (> 3px height).

**X-axis labels:** below the baseline, fontSize 9, color `#9ca3af`.

**Legend:** single color swatch + metric name displayed above the chart (e.g., "Tokens · Provider").

**Title (inside card header):** `"Tokens — Provider — August 2026"` (metric · dimension · range label).

**Dimension Tabs** (below chart): `"Provider"` | `"Model"` | `"API Key"`. These are secondary tabs, smaller font (text-xs), rendered below the chart SVG. Default: `"Provider"`.

---

## 8. Breakdown Chart

**Container:** `glass-panel Card` (existing component), padded.

**Controls row** (inside card header, right-aligned):
- Metric Tabs: `"Tokens"` | `"Cost"`
- Separator `·`
- Dimension Tabs: `"Provider"` | `"Model"` | `"API Key"`

**Top-N logic:** Sort by metric value descending, take top 10. Everything else aggregated into `"Other"` bucket. If fewer than 10 entries, no `"Other"` bucket.

**Bar chart:** Horizontal bars, max width = 60% of container, then labels on the right:
- Bar fill: alternating `#3b82f6` / `#2563eb` (light/dark blue)
- "Other" bar: `#6b7280` (gray)
- Label (left): truncated name (max 20 chars, tooltip for full)
- Percentage label (inside or beside bar): e.g., "40%"
- Value label (right): formatted metric value, e.g., "987,654 tokens" or "$12.34"

**SVG dimensions:** height = 40px per row + 60px header = ~460px viewBox, width 100%.

**Empty state:** "No data for this period" centered message.

**Title:** `"Top 10 — Provider"` (dimension · dimension label).

---

## 9. Color Palette

| Token              | Value      | Usage                              |
|--------------------|------------|------------------------------------|
| `--color-primary`  | `#3b82f6`  | Tokens bar, primary bars           |
| `--color-info`     | `#8b5cf6`  | Input tokens card accent           |
| `--color-warning`  | `#f59e0b`  | Output tokens card accent          |
| `--color-success`  | `#10b981`  | Cost card accent, cost bars        |
| `--color-gray`     | `#6b7280`  | Zero bars, "Other" bar             |
| `--color-muted`    | `#9ca3af`  | X-axis labels                     |

---

## 10. Error Handling

- If the loader throws, React Router default error boundary is shown.
- If SQL returns empty results, the charts show zero-state (no bars or a single zero bar), and stat cards show `—`.
- Invalid URL params fall back to defaults silently.

---

## 11. Implementation Steps

1. **Fix timestamp bug in stats.ts** — divide `created_at` by 1000 in all date queries (bug fix, included for correctness)

2. **Create `app/.server/usage.ts`** — new module with:
   - `type TimeRange = "day" | "week" | "month" | "year" | "all"`
   - `type Metric = "tokens" | "cost"`
   - `type Dimension = "provider" | "model" | "apikey"`
   - `computeCost(promptTokens, completionTokens, model, providerId): number` — calls `getPrice()`
   - `getUsageData(opts: { range, metric, dimension })` — returns `{ summary, timeSeries, breakdown }`
   - Three internal query builders: `_querySummary()`, `_queryTimeSeries()`, `_queryBreakdown()`

3. **Rewrite `app/routes/analytics.usage.tsx`** — replace stub with full page:
   - Loader: parse `range`, `metric`, `dimension` from URL params, call `getUsageData()`
   - State: useSearchParams for tab state (read from URL, update via links)
   - Stat cards row
   - Time-series card + chart
   - Breakdown card + chart

4. **Create `app/components/usage/time-series-chart.tsx`** — hand-rolled SVG time-series chart. Props:
   ```ts
   type Props = {
     data: { label: string; labelFull: string; value: number }[];
     metric: Metric;
     viewBox?: { w: number; h: number };
   };
   ```

5. **Create `app/components/usage/breakdown-chart.tsx`** — hand-rolled SVG horizontal bar chart. Props:
   ```ts
   type Entry = { name: string; value: number; pct: number };
   type Props = {
     data: (Entry | { name: "Other"; value: number; pct: number })[];
     metric: Metric;
   };
   ```

6. **Add placeholder images or design doc** — the design doc is text-only per spec guidelines (no visual companion needed for this design).

---

## 12. File Changes Summary

| File                                          | Action |
|-----------------------------------------------|--------|
| `app/.server/usage.ts`                        | Create |
| `app/routes/analytics.usage.tsx`             | Rewrite |
| `app/components/usage/time-series-chart.tsx` | Create |
| `app/components/usage/breakdown-chart.tsx`    | Create |
| `app/.server/stats.ts`                        | Fix bug (timestamp division) |

Existing files with no changes: `UsageChart` (simple), `Sidebar`, `Header`.

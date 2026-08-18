# Usage Page Enhancement — Design Spec

**Date:** 2026-08-18
**Status:** Approved
**Author:** design (brainstorming session 2026-08-18)

---

## 1. Goal

Enhance the existing Usage page at `/analytics/usage` (built 2026-08-17) to be **more informative** and **mobile-friendly**:

- Add request-volume, success-rate, latency, and per-request efficiency metrics.
- Add trend deltas (% change vs the previous equivalent period) on every stat card.
- Add a Status & Errors section (segmented success/error bar + top error messages).
- Replace both fixed-viewBox SVG charts with responsive HTML/CSS bars and add subtle staggered grow animations.

No changes to the `request_logs` schema. No new runtime dependencies.

## 2. Non-Goals

- No full page redesign / tabbed overview (Approach B was rejected; Approach A chosen).
- No new chart library — HTML/CSS bars only.
- No auto-generated "insights/highlights" callouts (user declined this option).
- No export / CSV.
- No client-side data fetching; loader re-runs on tab change (existing behavior).
- No changes to API Key dimension behavior (real data has all-null `api_key_id`; kept as-is for form completeness).

## 3. Data Layer — `app/.server/usage.ts`

Extend the `UsageData` type returned by `getUsageData()` with three new fields. All computed server-side; no new deps.

```ts
type UsageData = {
  summary: UsageSummary;        // existing: totalTokens, inputTokens, outputTokens, cost
  performance: {
    requests: number;           // row count in range
    successRate: number;        // % 0-100, rounded
    avgLatencyMs: number;       // AVG(duration_ms), rounded
    tokensPerReq: number;       // totalTokens / requests
    costPerReq: number;         // cost / requests
  };
  trends: {
    totalTokens: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cost: number | null;
    requests: number | null;
    successRate: number | null; // absolute-point delta (e.g. +4.0), not %
    avgLatencyMs: number | null;
    tokensPerReq: number | null;
  };
  errors: {
    success: number;
    error: number;
    total: number;
    top: { message: string; count: number }[]; // top 5 by count
  };
  // existing: timeSeries, breakdown, range, metric, dimension
};
```

### 3.1 Trend semantics

Calendar-based previous window via a new `prevRangeBounds(range)` helper:

| Range  | Current window                     | Previous window                          |
|--------|------------------------------------|------------------------------------------|
| day    | Today 00:00 UTC → now              | Yesterday 00:00 UTC → today 00:00 UTC    |
| week   | Mon 00:00 UTC → now                | Previous Mon 00:00 UTC → this Mon 00:00  |
| month  | 1st of month 00:00 UTC → now       | Previous calendar month 00:00 → 1st      |
| year   | Jan 1 00:00 UTC → now              | Previous calendar year                   |
| all    | first record → now                 | `null` (no prior period)                 |

- Trends recompute the summary query against the previous window. `delta = prev === 0 || prev === null ? null : ((curr - prev) / prev) * 100`.
- Round to 1 decimal; sign included. `null` → the UI shows "—" (no prior data).
- `successRate` trend is an **absolute-point** delta (e.g., `+4.0`), not a percentage change.

### 3.2 Status & errors query

- `GROUP BY status` counts within the range → `errors.success` (status `success`) and `errors.error` (every non-success status: `error`, `timeout`, `denied`), so `errors.success + errors.error` equals the row count. The top-errors query filters `status != 'success'`.
- Top errors: `WHERE error_message IS NOT NULL GROUP BY error_message ORDER BY COUNT(*) DESC LIMIT 5`.
- Error message extraction (UI-side helper): if the string parses as JSON and has `error.message`, use that; otherwise use the raw text. Truncate to ~60 chars for display; full text in `title` tooltip.

## 4. Stat Cards — 2 rows of 4, with trend deltas

### 4.1 `StatCard` extension

Add optional, backward-compatible props:

```ts
delta?: { value: number | null; good: boolean }; // good = up is positive
```

Renders a small badge under the value: **▲ +12%** (green when `good`, red when not), **▼ -8%** (red when `good`, green when not), or **—** when `value === null`. Arrow glyph + numeric delta only; no tooltip. Exception: the Success Rate card displays its trend as an absolute-point delta with "pts" suffix (e.g., **▲ +4.0 pts**), matching Section 3.1.

### 4.2 Card layout

| # | Row 1 (tokens & cost) | Accent     | Trend direction (up = ?) |
|---|-----------------------|------------|--------------------------|
| 1 | Total Tokens          | `bg-primary`  | neutral (green)       |
| 2 | Input Tokens          | `bg-info`     | neutral (green)       |
| 3 | Output Tokens         | `bg-warning`  | neutral (green)       |
| 4 | Est. Cost             | `bg-success`  | down is good (cost)   |

| # | Row 2 (performance)   | Accent     | Trend direction (up = ?) |
|---|-----------------------|------------|--------------------------|
| 5 | Requests              | `bg-primary`  | neutral (green)       |
| 6 | Success Rate (suffix `%`) | `bg-success` | up is good         |
| 7 | Avg Latency (suffix `ms`) | `bg-warning` | down is good       |
| 8 | Avg Tokens/Req        | `bg-info`     | neutral (green)       |

- **Avg Cost/Req** is a muted sub-line under the Est. Cost card value (keeps grid at 8 cards).
- Grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-4`, `gap-4`, `mb-6`.
- Existing formatting rules preserved: `toLocaleString()` for token/request counts, `$${n.toFixed(2)}` for cost, em dash "—" when value is 0/no data.

## 5. Charts — HTML/CSS bars with animations

### 5.1 Time-series chart (`app/components/usage/time-series-chart.tsx`)

- Container: `overflow-x-auto`; inner flex row of bucket columns, each with `min-width` ~24px. Many buckets (Month = 30+) scroll horizontally on narrow screens instead of crushing.
- Each column (top→bottom): value label (hidden below `sm:`, accessible via `title` tooltip), bar (`rounded`, height = value/max × ~160px), short x-axis label.
- Animation: `@keyframes growY { from { transform: scaleY(0) } }`, `transform-origin: bottom`, stagger `animation-delay: i * 25ms`, duration ~450ms `ease-out`. Pure transform, compositor-smooth. Respect `prefers-reduced-motion` (skip animation).
- Colors unchanged: tokens `#3b82f6`, cost `#10b981`, zero-value `#4b5563`.
- Keep `role="img"` + `aria-label`, per-bar `title` = full label + value.
- Empty state: existing "No data for this period".

### 5.2 Breakdown chart (`app/components/usage/breakdown-chart.tsx`)

- One row per entry. Desktop (`md:`+): label (fixed ~40% width, truncated + `title`), bar, pct, value on one line. Mobile (`< md:`): label on line 1, bar full-width below with value + pct right-aligned — no clipping.
- Bar width = value/max × available. Colors same as before (alternating `#3b82f6`/`#2563eb`, `Other` = `#6b7280`).
- Animation: `@keyframes growX` scaleX(0)→1, `transform-origin: left`, stagger 25ms, ~450ms `ease-out`. Respect `prefers-reduced-motion`.
- Empty state: existing "No data for this period".

## 6. Status & Errors Card

New card below the breakdown.

- **Segmented bar:** full-width flex row, two segments sized by share — `success` `#10b981`, `error` danger red. Legend line below: colored dots + "17 success (49%) · 18 error (51%)".
- **Top errors list:** top 5 messages; each row = truncated message (~60 chars, `title` = full) + count badge. No errors → "No errors in this period".
- **Efficiency line:** muted row — "Avg cost per request: $0.0042 · Avg tokens/request: 312".
- Sparse data: all-null tokens → cost shows "—", errors list still shows statuses.

## 7. Page Layout & Mobile Behavior (`app/routes/analytics.usage.tsx`)

- Structure: `PageHeader` (range tabs, already scrollable via `tabs-scroll`) → 2×4 stat cards → Time-series card → Breakdown card → Status & Errors card.
- `CardHeader` gets `flex-wrap` so title + tab groups stack cleanly on narrow screens (chart card currently risks overflow with two tab rows).
- Mobile stacking: cards 1-col; charts reflow; time-series scrolls horizontally; breakdown restacks label/bar/value.

## 8. File Changes Summary

| File | Action |
|------|--------|
| `app/.server/usage.ts` | Modify — add `performance`, `trends`, `errors`; `prevRangeBounds`; error top-N query |
| `app/.server/usage.test.ts` | Modify — add tests for performance, trends, errors |
| `app/components/ui/stat-card.tsx` | Modify — add optional `delta` badge |
| `app/components/usage/time-series-chart.tsx` | Rewrite — HTML/CSS bars + animation |
| `app/components/usage/breakdown-chart.tsx` | Rewrite — HTML/CSS bars + animation |
| `app/routes/analytics.usage.tsx` | Modify — 8 cards with deltas, Status & Errors card, card-header wrap |
| `app/app.css` | Modify — add `growY`/`growX` keyframes + reduced-motion guard |

## 9. Error Handling

- Loader throws → existing React Router error boundary.
- Empty SQL results → charts zero-state, cards "—", errors card "No errors in this period".
- Invalid URL params → fall back to defaults silently (existing).

## 10. Testing

- Extend `usage.test.ts`:
  - Performance aggregation (requests, success rate, avg latency, tokens/req, cost/req).
  - Trend deltas: current + previous window, `null` when no prior data, success-rate point delta.
  - Errors: status grouping, top-5 by count.
- Keep existing tests green.
- Verification: `npm run typecheck`, `npm test`, `npm run build`, manual smoke at mobile width (e.g., ~375px) and desktop.

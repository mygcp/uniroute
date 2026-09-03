import { Fragment, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { Route } from "./+types/analytics.usage";
import { ChevronDown, Search, TrendingUp, X } from "lucide-react";
import {
  getUsageData,
  type BreakdownEntry,
  type Dimension,
  type Metric,
  type ModelInsight,
  type TimeRange,
} from "../.server/usage";
import { TimeSeriesChart } from "../components/usage/time-series-chart";
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

function fmtCostPrecise(n: number): string {
  if (n <= 0) return "—";
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function fmtBreakdownValue(value: number, metric: Metric): string {
  if (metric === "cost") return value > 0 ? `$${value.toFixed(2)}` : "—";
  return `${value.toLocaleString()} tokens`;
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
): { value: number | null; good: boolean } {
  return { value, good };
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

/** Clickable breakdown rows: select an entry to filter the model detail table below. */
function InteractiveBreakdown({
  data,
  metric,
  selected,
  onSelect,
}: {
  data: BreakdownEntry[];
  metric: Metric;
  selected: string | null;
  onSelect: (name: string | null) => void;
}) {
  if (data.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No data for this period
      </div>
    );
  }
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <ul className="space-y-2">
      {data.map((d, i) => {
        const active = selected === d.name;
        const pctW = Math.round((d.value / max) * 100);
        const fill =
          d.name === "Other" ? "bg-[#6b7280]" : i % 2 === 0 ? "bg-primary" : "bg-primary/70";
        return (
          <li key={`${d.name}-${i}`}>
            <button
              type="button"
              onClick={() => onSelect(active ? null : d.name)}
              aria-pressed={active}
              title={`${d.name}: ${fmtBreakdownValue(d.value, metric)} (${d.pct}%) — click to filter details`}
              className={`flex w-full flex-col gap-1 rounded-lg border px-2 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:flex-row md:items-center md:gap-3 ${
                active
                  ? "border-primary/60 bg-primary/10"
                  : "border-transparent hover:border-glass-border hover:bg-glass-hover"
              }`}
            >
              <span className="flex items-center justify-between gap-2 md:w-40 md:shrink-0">
                <span className="truncate text-sm text-muted-foreground" title={d.name}>
                  {d.name}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground md:hidden">
                  {fmtBreakdownValue(d.value, metric)}
                </span>
              </span>
              <span className="flex flex-1 items-center gap-2">
                <span className="h-4 flex-1 overflow-hidden rounded-sm bg-white/5">
                  <span className={`bar-grow-x block h-full ${fill}`} style={{ width: `${pctW}%` }} />
                </span>
                <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {d.pct}%
                </span>
                <span className="hidden w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground md:block">
                  {fmtBreakdownValue(d.value, metric)}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Per-model drilldown table: click a row to expand providers + per-request stats. */
function ModelTable({
  models,
  drill,
  onDrill,
}: {
  models: ModelInsight[];
  drill: string | null;
  onDrill: (model: string | null) => void;
}) {
  if (models.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">No models match this filter</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] text-left text-sm">
        <thead>
          <tr className="border-b border-glass-border text-xs text-muted-foreground">
            <th scope="col" className="w-6 py-2 pr-2 font-medium" aria-label="Expand" />
            <th scope="col" className="py-2 pr-3 font-medium">Model</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Requests</th>
            <th scope="col" className="hidden py-2 pr-3 text-right font-medium sm:table-cell">Tokens</th>
            <th scope="col" className="py-2 pr-3 text-right font-medium">Cost</th>
            <th scope="col" className="py-2 text-right font-medium">Err %</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const open = drill === m.model;
            return (
              <Fragment key={m.model}>
                <tr
                  onClick={() => onDrill(open ? null : m.model)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onDrill(open ? null : m.model);
                    }
                  }}
                  tabIndex={0}
                  aria-expanded={open}
                  title={`${m.model}: ${m.requests} requests, ${fmtBreakdownValue(m.tokens, "tokens")}, ${fmtCostPrecise(m.cost)} — click for providers`}
                  className={`cursor-pointer border-b border-glass-border/50 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                    open ? "bg-primary/10" : "hover:bg-glass-hover"
                  }`}
                >
                  <td className="py-2 pr-2 text-muted-foreground">
                    <ChevronDown
                      size={16}
                      className={`transition-transform ${open ? "rotate-180" : ""}`}
                    />
                  </td>
                  <td className="max-w-36 truncate py-2 pr-3 font-medium text-foreground" title={m.model}>
                    {m.model}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {m.requests.toLocaleString()}
                  </td>
                  <td className="hidden py-2 pr-3 text-right tabular-nums text-muted-foreground sm:table-cell">
                    {m.tokens.toLocaleString()}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {fmtCostPrecise(m.cost)}
                  </td>
                  <td
                    className={`py-2 text-right tabular-nums ${
                      m.errorRate > 0 ? "text-danger" : "text-muted-foreground"
                    }`}
                  >
                    {m.errorRate}%
                  </td>
                </tr>
                {open ? (
                  <tr className="border-b border-glass-border/50 bg-white/[0.02]">
                    <td />
                    <td colSpan={5} className="py-3 pr-2">
                      <div className="flex flex-wrap gap-1.5">
                        {m.providers.map((p) => (
                          <span
                            key={p}
                            className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-muted-foreground"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                        <div className="flex gap-1.5">
                          <dt>Avg tokens / req:</dt>
                          <dd className="tabular-nums text-foreground">
                            {m.avgTokensPerReq.toLocaleString()}
                          </dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt>Cost / req:</dt>
                          <dd className="tabular-nums text-foreground">
                            {fmtCostPrecise(m.requests ? m.cost / m.requests : 0)}
                          </dd>
                        </div>
                        <div className="flex gap-1.5">
                          <dt>Failed requests:</dt>
                          <dd className="tabular-nums text-foreground">
                            {m.errors} of {m.requests}
                          </dd>
                        </div>
                      </dl>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function AnalyticsUsage({ loaderData }: Route.ComponentProps) {
  const {
    summary,
    performance,
    trends,
    errors,
    timeSeries,
    breakdown,
    successTrend,
    latency,
    modelInsights,
    range,
    metric,
    dimension,
  } = loaderData;
  const { setRange, setMetric, setDimension } = useUsageParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [drill, setDrill] = useState<string | null>(null);
  const [modelQuery, setModelQuery] = useState("");
  const [showSuccessTrend, setShowSuccessTrend] = useState(false);

  const errTotal = errors.total || 1;
  const successPct = errors.total ? Math.round((errors.success / errors.total) * 100) : 0;
  const errorPct = errors.total ? Math.round((errors.error / errors.total) * 100) : 0;

  const filteredModels = useMemo(() => {
    const q = modelQuery.trim().toLowerCase();
    return modelInsights.filter((m) => {
      if (selected && dimension === "model" && m.model !== selected) return false;
      if (selected && dimension === "provider" && !m.providers.includes(selected)) return false;
      if (
        q &&
        !m.model.toLowerCase().includes(q) &&
        !m.providers.some((p) => p.toLowerCase().includes(q))
      )
        return false;
      return true;
    });
  }, [modelInsights, selected, dimension, modelQuery]);

  const failingModels = useMemo(
    () =>
      modelInsights
        .filter((m) => m.errors > 0)
        .sort((a, b) => b.errors - a.errors)
        .slice(0, 5),
    [modelInsights],
  );

  const secondaryStats = (
    <>
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
        title="Cache Tokens"
        value={fmtTokens(summary.cachedTokens)}
        accent="bg-primary/60"
        delta={deltaProps(trends.cachedTokens, true)}
        subline="Served from provider cache"
      />
      <StatCard
        title="Avg Tokens / Req"
        value={fmtTokens(Math.round(performance.tokensPerReq))}
        accent="bg-info"
        delta={deltaProps(trends.tokensPerReq, true)}
      />
      <StatCard
        title="Latency p95"
        value={latency.p95 > 0 ? latency.p95.toLocaleString() : "—"}
        suffix={latency.p95 > 0 ? "ms" : undefined}
        accent="bg-warning"
        subline={`p50: ${latency.p50 > 0 ? `${latency.p50.toLocaleString()}ms` : "—"}`}
      />
    </>
  );

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

      {/* Primary stats: 2-col on mobile instead of a 9-card stacked wall */}
      <div className="mb-4 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
        <StatCard
          title="Total Tokens"
          value={fmtTokens(summary.totalTokens)}
          delta={deltaProps(trends.totalTokens, true)}
        />
        <StatCard
          title="Est. Cost"
          value={fmtCost(summary.cost)}
          accent="bg-success"
          delta={deltaProps(trends.cost, false)}
          subline={`Avg cost / request: ${fmtCostPrecise(performance.costPerReq)}`}
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
          delta={deltaProps(trends.successRate, true)}
          deltaSuffix=" pts"
        />
        <StatCard title="Error Rate" value={errorPct} suffix="%" accent="bg-danger" />
        <StatCard
          title="Avg Latency"
          value={fmtTokens(performance.avgLatencyMs)}
          suffix="ms"
          accent="bg-warning"
          delta={deltaProps(trends.avgLatencyMs, false)}
        />
      </div>

      {/* Secondary stats: collapsible on mobile, plain grid on desktop */}
      <details className="mb-6 lg:hidden">
        <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">
          More stats (token split, p95 latency)
        </summary>
        <div className="mt-3 grid grid-cols-2 gap-3">{secondaryStats}</div>
      </details>
      <div className="mb-6 hidden grid-cols-5 gap-4 lg:grid">{secondaryStats}</div>

      <Card className="mb-6">
        <CardHeader className="flex-wrap">
          <CardTitle>
            {showSuccessTrend
              ? `Success rate — ${rangeTitle(range)}`
              : `${metric === "tokens" ? "Tokens" : "Cost"} — ${DIMENSION_LABEL[dimension]} — ${rangeTitle(range)}`}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              tabs={["Volume", "Success %"]}
              active={showSuccessTrend ? "Success %" : "Volume"}
              onChange={(label) => setShowSuccessTrend(label === "Success %")}
            />
            <span className="text-xs text-muted-foreground">·</span>
            <Tabs
              tabs={METRICS.map((m) => (m === "tokens" ? "Tokens" : "Cost"))}
              active={metric === "tokens" ? "Tokens" : "Cost"}
              onChange={(label) => {
                const m = label === "Cost" ? "cost" : "tokens";
                setMetric(m);
              }}
            />
          </div>
        </CardHeader>
        {showSuccessTrend ? (
          <TimeSeriesChart data={successTrend} metric="tokens" format={(v) => `${v}%`} />
        ) : (
          <TimeSeriesChart data={timeSeries} metric={metric} />
        )}
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
          <div className="flex flex-wrap items-center gap-2">
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
        <InteractiveBreakdown
          data={breakdown}
          metric={metric}
          selected={selected}
          onSelect={setSelected}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          {selected ? (
            <span className="flex flex-wrap items-center gap-2">
              Filtering details by <span className="font-medium text-foreground">{selected}</span>
              <button
                type="button"
                onClick={() => setSelected(null)}
                className="flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X size={12} /> Clear
              </button>
            </span>
          ) : (
            "Click a row to filter the model details below"
          )}
        </p>
      </Card>

      <Card className="mb-6">
        <CardHeader className="flex-wrap">
          <CardTitle>Model details</CardTitle>
          <label className="flex items-center gap-1.5 rounded-lg border border-glass-border bg-white/[0.02] px-2 py-1.5 text-sm focus-within:ring-2 focus-within:ring-ring/50">
            <Search size={14} className="shrink-0 text-muted-foreground" />
            <span className="sr-only">Filter models</span>
            <input
              value={modelQuery}
              onChange={(e) => setModelQuery(e.target.value)}
              placeholder="Filter models…"
              className="w-32 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none sm:w-44"
            />
            {modelQuery ? (
              <button
                type="button"
                onClick={() => setModelQuery("")}
                aria-label="Clear model filter"
                className="text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X size={14} />
              </button>
            ) : null}
          </label>
        </CardHeader>
        {selected && dimension === "apikey" ? (
          <p className="mb-3 text-xs text-muted-foreground">
            Breakdown filters apply to Model / Provider dimensions; showing all models.
          </p>
        ) : null}
        <ModelTable models={filteredModels} drill={drill} onDrill={setDrill} />
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

          {failingModels.length > 0 ? (
            <div>
              <h3 className="mb-2 text-sm font-semibold text-foreground">Top failing models</h3>
              <ul className="space-y-1.5">
                {failingModels.map((m) => (
                  <li key={m.model}>
                    <button
                      type="button"
                      onClick={() => {
                        setModelQuery(m.model);
                        setDrill(m.model);
                      }}
                      title={`${m.model}: ${m.errors} failures (${m.errorRate}%) — click to inspect`}
                      className="flex w-full items-center gap-2 rounded-lg px-1 py-0.5 text-left text-sm transition hover:bg-glass-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <code className="flex-1 truncate text-xs text-muted-foreground">
                        {m.model}
                      </code>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {m.errorRate}% err
                      </span>
                      <span className="shrink-0 rounded-full bg-danger/15 px-2 py-0.5 text-xs tabular-nums text-danger">
                        {m.errors}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

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
            Avg cost / request: <span className="tabular-nums">{fmtCostPrecise(performance.costPerReq)}</span> · Avg
            tokens / request: <span className="tabular-nums">{fmtTokens(Math.round(performance.tokensPerReq))}</span> · Latency
            p50 / p95: <span className="tabular-nums">{latency.p50 > 0 ? `${latency.p50}ms` : "—"} / {latency.p95 > 0 ? `${latency.p95}ms` : "—"}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

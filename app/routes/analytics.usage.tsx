import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { Route } from "./+types/analytics.usage";
import { requireLoaderSession } from "../.server/auth";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronDown, TrendingUp, X } from "lucide-react";
import { Badge } from "../components/ui/badge";
import { SearchInput } from "../components/ui/filter-bar";
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
import { StatCard, MetricStrip } from "../components/ui/stat-card";
import { Tabs } from "../components/ui/tabs";
import { Card, CardHeader, CardTitle } from "../components/ui/card";

export function meta() {
  return [{ title: "Usage Analytics | UniRoute" }];
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
  requireLoaderSession(request);
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
  return n > 0 ? n.toLocaleString() : "-";
}

function fmtCost(n: number): string {
  return n > 0 ? `$${n.toFixed(2)}` : "-";
}

function fmtCostPrecise(n: number): string {
  if (n <= 0) return "-";
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function fmtBreakdownValue(value: number, metric: Metric): string {
  if (metric === "cost") return value > 0 ? `$${value.toFixed(2)}` : "-";
  return `${value.toLocaleString()} tokens`;
}

function shortError(msg: string, max = 60): string {
  let text = msg;
  try {
    const parsed = JSON.parse(msg) as { error?: { message?: string }; message?: string };
    text = parsed?.error?.message ?? parsed?.message ?? msg;
  } catch {
    /* not JSON - use raw text */
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
        const isOther = d.name === "Other";
        const active = !isOther && selected === d.name;
        const pctW = Math.round((d.value / max) * 100);
        const fill =
          isOther ? "bg-muted-foreground/60" : i % 2 === 0 ? "bg-primary" : "bg-primary/70";
        return (
          <li key={`${d.name}-${i}`}>
            <button
              type="button"
              disabled={isOther}
              onClick={() => {
                if (!isOther) onSelect(active ? null : d.name);
              }}
              aria-pressed={active}
              title={
                isOther
                  ? `${d.name}: ${fmtBreakdownValue(d.value, metric)} (${d.pct}%)`
                  : `${d.name}: ${fmtBreakdownValue(d.value, metric)} (${d.pct}%), click to filter details`
              }
              className={`flex w-full flex-col gap-1 rounded-lg border px-2 py-1.5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:flex-row md:items-center md:gap-3 ${
                active
                  ? "border-primary/60 bg-primary/10"
                  : isOther
                    ? "cursor-default border-transparent opacity-85"
                    : "border-transparent hover:border-border hover:bg-surface-2"
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
                <span className="h-4 flex-1 overflow-hidden rounded-md bg-track">
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

type ModelSortKey = "requests" | "tokens" | "cost" | "errorRate" | "model";

/** Per-model sortable drilldown table: click a row to expand providers and per-request stats. */
function ModelTable({
  models,
  drill,
  onDrill,
}: {
  models: ModelInsight[];
  drill: string | null;
  onDrill: (model: string | null) => void;
}) {
  const [sortBy, setSortBy] = useState<ModelSortKey>("tokens");
  const [sortDir, setSortDir] = useState<"desc" | "asc">("desc");

  const sorted = useMemo(() => {
    const copy = [...models];
    copy.sort((a, b) => {
      const mul = sortDir === "asc" ? 1 : -1;
      if (sortBy === "model") {
        return mul * a.model.localeCompare(b.model, undefined, { sensitivity: "base" });
      }
      return mul * (a[sortBy] - b[sortBy]);
    });
    return copy;
  }, [models, sortBy, sortDir]);

  const maxTokens = Math.max(1, ...models.map((m) => m.tokens));
  const maxReqs = Math.max(1, ...models.map((m) => m.requests));

  const toggleSort = (key: ModelSortKey) => {
    if (sortBy === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortBy(key);
      setSortDir(key === "model" ? "asc" : "desc");
    }
  };

  if (models.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        No models match this filter.
      </p>
    );
  }

  const SortTh = ({
    col,
    label,
    align = "right",
    className = "",
  }: {
    col: ModelSortKey;
    label: string;
    align?: "left" | "right";
    className?: string;
  }) => {
    const active = sortBy === col;
    return (
      <th
        scope="col"
        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
        className={`py-2.5 px-3 font-semibold ${align === "right" ? "text-right" : "text-left"} ${className}`}
      >
        <button
          type="button"
          onClick={() => toggleSort(col)}
          className={`inline-flex items-center gap-1 text-xs font-medium transition-colors hover:text-foreground ${
            active ? "text-primary" : "text-muted-foreground"
          }`}
        >
          {label}
          {active ? (
            sortDir === "asc" ? (
              <ArrowUp size={11} aria-hidden="true" />
            ) : (
              <ArrowDown size={11} aria-hidden="true" />
            )
          ) : (
            <ArrowUpDown size={11} aria-hidden="true" className="opacity-50" />
          )}
        </button>
      </th>
    );
  };

  return (
    <div className="table-wrap">
      <table className="w-full min-w-[38rem] text-left text-sm">
        <thead className="border-y border-border bg-surface-2/60">
          <tr>
            <th scope="col" className="w-10 py-2.5 pl-4 pr-1" aria-label="Expand" />
            <SortTh col="model" label="Model" align="left" />
            <SortTh col="requests" label="Requests" />
            <SortTh col="tokens" label="Tokens" />
            <SortTh col="cost" label="Est. Cost" />
            <SortTh col="errorRate" label="Error Rate" className="pr-4" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {sorted.map((m) => {
            const open = drill === m.model;
            const tokPct = Math.max(2, Math.round((m.tokens / maxTokens) * 100));
            const reqPct = Math.max(2, Math.round((m.requests / maxReqs) * 100));
            return (
              <Fragment key={m.model}>
                <tr
                  className={`transition-colors ${
                    open ? "bg-primary/10" : "hover:bg-surface-2/55"
                  }`}
                >
                  <td className="py-3 pl-4 pr-1">
                    <button
                      type="button"
                      onClick={() => onDrill(open ? null : m.model)}
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} details for ${m.model}`}
                      className="grid h-7 w-7 place-items-center rounded-md border border-border bg-surface text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
                    >
                      <ChevronDown
                        size={14}
                        aria-hidden="true"
                        className={`transition-transform ${open ? "rotate-180" : ""}`}
                      />
                    </button>
                  </td>
                  <td className="py-3 px-3">
                    <button
                      type="button"
                      onClick={() => onDrill(open ? null : m.model)}
                      className="block max-w-[260px] text-left sm:max-w-[340px]"
                      title={m.model}
                    >
                      <span className="block truncate font-mono text-xs font-semibold text-foreground hover:text-primary">
                        {m.model}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {m.providers.join(", ")}
                      </span>
                    </button>
                  </td>
                  <td className="py-3 px-3 text-right">
                    <div className="inline-flex flex-col items-end">
                      <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                        {m.requests.toLocaleString()}
                      </span>
                      <span className="mt-1 h-1 w-16 overflow-hidden rounded-full bg-track">
                        <span
                          className="block h-full rounded-full bg-info"
                          style={{ width: `${reqPct}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-right">
                    <div className="inline-flex flex-col items-end">
                      <span className="font-mono text-xs font-medium tabular-nums text-foreground">
                        {m.tokens.toLocaleString()}
                      </span>
                      <span className="mt-1 h-1 w-20 overflow-hidden rounded-full bg-track">
                        <span
                          className="block h-full rounded-full bg-primary"
                          style={{ width: `${tokPct}%` }}
                        />
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3 text-right font-mono text-xs tabular-nums text-foreground">
                    {fmtCostPrecise(m.cost)}
                  </td>
                  <td className="py-3 pl-3 pr-4 text-right">
                    <Badge tone={m.errorRate > 0 ? "danger" : "success"}>
                      {m.errorRate}%
                    </Badge>
                  </td>
                </tr>
                {open ? (
                  <tr className="bg-surface-2/40">
                    <td colSpan={6} className="px-4 py-3.5 sm:px-6">
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                        <div className="rounded-lg border border-border bg-surface px-3 py-2">
                          <p className="text-[11px] text-muted-foreground">Avg tokens / req</p>
                          <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                            {m.avgTokensPerReq.toLocaleString()}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border bg-surface px-3 py-2">
                          <p className="text-[11px] text-muted-foreground">Avg cost / req</p>
                          <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                            {fmtCostPrecise(m.requests ? m.cost / m.requests : 0)}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border bg-surface px-3 py-2">
                          <p className="text-[11px] text-muted-foreground">Failed requests</p>
                          <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-foreground">
                            {m.errors.toLocaleString()} / {m.requests.toLocaleString()}
                          </p>
                        </div>
                        <div className="rounded-lg border border-border bg-surface px-3 py-2">
                          <p className="text-[11px] text-muted-foreground">Providers</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {m.providers.map((p) => (
                              <Badge key={p} tone="neutral">
                                {p}
                              </Badge>
                            ))}
                          </div>
                        </div>
                      </div>
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
  const modelCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSelected(null);
  }, [dimension]);

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
        value={latency.p95 > 0 ? latency.p95.toLocaleString() : "-"}
        suffix={latency.p95 > 0 ? "ms" : undefined}
        accent="bg-warning"
        subline={`p50: ${latency.p50 > 0 ? `${latency.p50.toLocaleString()}ms` : "-"}`}
      />
    </>
  );

  return (
    <div>
      <PageHeader
        title="Usage"
        icon={<TrendingUp size={20} />}
        subtitle={`${RANGE_LABEL[range]} · ${rangeTitle(range)}`}
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

      <MetricStrip
        className="mb-4"
        items={[
          {
            label: "Total tokens",
            value: fmtTokens(summary.totalTokens),
            detail: trends.totalTokens != null ? `${trends.totalTokens >= 0 ? "+" : ""}${trends.totalTokens}% vs prev` : undefined,
          },
          {
            label: "Estimated cost",
            value: fmtCost(summary.cost),
            detail: `Avg / req: ${fmtCostPrecise(performance.costPerReq)}`,
            tone: "success",
          },
          {
            label: "Requests",
            value: fmtTokens(performance.requests),
            detail: trends.requests != null ? `${trends.requests >= 0 ? "+" : ""}${trends.requests}% vs prev` : undefined,
          },
          {
            label: "Success rate",
            value: performance.requests > 0 ? performance.successRate : "-",
            suffix: performance.requests > 0 ? "%" : undefined,
            detail: errorPct != null ? `${errorPct}% error rate` : undefined,
            tone: performance.requests > 0 && performance.successRate < 90 ? "warning" : "success",
          },
          {
            label: "Average latency",
            value: performance.avgLatencyMs > 0 ? performance.avgLatencyMs.toLocaleString() : "-",
            suffix: performance.avgLatencyMs > 0 ? "ms" : undefined,
            detail: trends.avgLatencyMs != null ? `${trends.avgLatencyMs >= 0 ? "+" : ""}${trends.avgLatencyMs}% vs prev` : undefined,
          },
        ]}
      />

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
              ? `Success rate · ${rangeTitle(range)}`
              : `${metric === "tokens" ? "Tokens" : "Cost"} · ${rangeTitle(range)}`}
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Tabs
              tabs={["Volume", "Success %"]}
              active={showSuccessTrend ? "Success %" : "Volume"}
              onChange={(label) => setShowSuccessTrend(label === "Success %")}
            />
            {!showSuccessTrend ? (
              <Tabs
                tabs={METRICS.map((m) => (m === "tokens" ? "Tokens" : "Cost"))}
                active={metric === "tokens" ? "Tokens" : "Cost"}
                onChange={(label) => {
                  const m = label === "Cost" ? "cost" : "tokens";
                  setMetric(m);
                }}
              />
            ) : null}
          </div>
        </CardHeader>
        {showSuccessTrend ? (
          <TimeSeriesChart data={successTrend} metric="tokens" format={(v) => `${v}%`} />
        ) : (
          <TimeSeriesChart data={timeSeries} metric={metric} />
        )}
      </Card>

      <Card className="mb-6">
        <CardHeader className="flex-wrap">
          <CardTitle>Top {breakdown.length || 10} · {DIMENSION_LABEL[dimension]}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
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
                className="flex cursor-pointer items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <X size={12} /> Clear
              </button>
            </span>
          ) : (
            "Click a row to filter the model details below"
          )}
        </p>
      </Card>

      <div ref={modelCardRef}>
        <Card padded={false} className="mb-6 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Model Performance ({filteredModels.length})
              </h2>
              <p className="text-xs text-muted-foreground">
                Click any column header to sort, or expand a row to inspect per-request metrics.
              </p>
            </div>
            <SearchInput
              controlSize="sm"
              value={modelQuery}
              onChange={setModelQuery}
              placeholder="Filter models..."
              aria-label="Filter models"
              clearLabel="Clear model filter"
              containerClassName="w-full sm:w-56"
            />
          </div>
          {selected && dimension === "apikey" ? (
            <p className="px-4 pb-3 text-xs text-muted-foreground sm:px-5">
              Breakdown filters apply to Model / Provider dimensions; showing all models.
            </p>
          ) : null}
          <ModelTable models={filteredModels} drill={drill} onDrill={setDrill} />
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-wrap">
          <CardTitle>Status &amp; Errors</CardTitle>
        </CardHeader>
        <div className="space-y-5">
          <div>
            <div
              className="flex h-3 w-full overflow-hidden rounded-sm bg-track"
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
                        setSelected(null);
                        setModelQuery(m.model);
                        setDrill(m.model);
                        modelCardRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
                      }}
                      title={`${m.model}: ${m.errors} failures (${m.errorRate}%), click to inspect`}
                      className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                    <span className="shrink-0 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
                      {e.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No errors in this period</p>
          )}

          <div className="border-t border-border pt-3 text-xs text-muted-foreground">
            Avg cost / request: <span className="tabular-nums">{fmtCostPrecise(performance.costPerReq)}</span> · Avg
            tokens / request: <span className="tabular-nums">{fmtTokens(Math.round(performance.tokensPerReq))}</span> · Latency
            p50 / p95: <span className="tabular-nums">{latency.p50 > 0 ? `${latency.p50}ms` : "-"} / {latency.p95 > 0 ? `${latency.p95}ms` : "-"}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

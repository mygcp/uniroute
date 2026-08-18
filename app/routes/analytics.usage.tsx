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

function fmtCostPrecise(n: number): string {
  if (n <= 0) return "—";
  return n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
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
            Avg cost / request: <span className="tabular-nums">{fmtCostPrecise(performance.costPerReq)}</span> · Avg
            tokens / request: <span className="tabular-nums">{fmtTokens(Math.round(performance.tokensPerReq))}</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

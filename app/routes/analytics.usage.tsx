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

      <Card>
        <CardHeader>
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
    </div>
  );
}
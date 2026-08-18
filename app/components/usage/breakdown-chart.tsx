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

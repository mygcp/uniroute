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

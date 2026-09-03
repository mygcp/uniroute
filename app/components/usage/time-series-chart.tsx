import { useState } from "react";
import type { Metric, TimeSeriesPoint } from "../../.server/usage";

type Props = {
  data: TimeSeriesPoint[];
  metric: Metric;
  barHeight?: number;
  /** Override how exact values are rendered (e.g. success-rate "%"). Defaults to metric formatting. */
  format?: (value: number) => string;
};

function fmtValue(value: number, metric: Metric): string {
  if (metric === "cost") return `$${value.toFixed(2)}`;
  return value.toLocaleString();
}

export function TimeSeriesChart({ data, metric, barHeight = 160, format }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  if (data.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No data for this period
      </div>
    );
  }
  const fmt = (v: number): string => (format ? format(v) : fmtValue(v, metric));
  const max = Math.max(1, ...data.map((d) => d.value));
  const fill = metric === "cost" ? "bg-success" : "bg-primary";
  const active = hovered != null && hovered >= 0 && hovered < data.length ? data[hovered] : null;

  return (
    <div>
      <div className="w-full overflow-x-auto" role="img" aria-label={`${metric} time series`}>
        <div className="flex items-end gap-1.5" style={{ minWidth: `${data.length * 32}px` }}>
          {data.map((d, i) => {
            const h = d.value > 0 ? Math.max(3, (d.value / max) * barHeight) : 3;
            const isActive = hovered === i;
            return (
              <div
                key={`${d.labelFull}-${i}`}
                className={`flex flex-1 cursor-default flex-col items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  isActive ? "opacity-100" : ""
                }`}
                tabIndex={0}
                role="button"
                aria-label={`${d.labelFull}: ${fmt(d.value)}`}
                title={`${d.labelFull}: ${fmt(d.value)}`}
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered(null)}
                onFocus={() => setHovered(i)}
                onBlur={() => setHovered(null)}
                onClick={() => setHovered(isActive ? null : i)}
              >
                <span
                  className={`text-xs leading-none tabular-nums ${
                    isActive ? "block text-foreground" : "hidden text-muted-foreground sm:block"
                  }`}
                >
                  {fmt(d.value)}
                </span>
                <div className="flex w-full items-end" style={{ height: barHeight }}>
                  <div
                    className={`bar-grow-y w-full rounded-sm ${
                      d.value > 0 ? fill : "bg-[#4b5563]"
                    } ${isActive ? "ring-2 ring-foreground/60" : ""}`}
                    style={{ height: `${h}px`, animationDelay: `${i * 25}ms` }}
                  />
                </div>
                <span className="text-xs leading-none text-muted-foreground">{d.label}</span>
              </div>
            );
          })}
        </div>
      </div>
      <p aria-live="polite" className="mt-2 min-h-4 text-xs tabular-nums text-muted-foreground">
        {active ? (
          <>
            <span className="font-medium text-foreground">{active.labelFull}</span>
            {" — "}
            {fmt(active.value)}
          </>
        ) : (
          <>
            {data.length} point{data.length === 1 ? "" : "s"} · max {fmt(max)} · hover or tap a bar
            for exact values
          </>
        )}
      </p>
    </div>
  );
}

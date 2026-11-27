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

function fmtShort(value: number, metric: Metric): string {
  if (metric === "cost") {
    if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
    return `$${value.toFixed(value < 1 && value > 0 ? 2 : 1)}`;
  }
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
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
  const fmtLabel = (v: number): string => (format ? format(v) : fmtShort(v, metric));
  const max = Math.max(1, ...data.map((d) => d.value));
  const fill =
    metric === "cost"
      ? "bg-success"
      : "bg-primary";
  const active =
    hovered != null && hovered >= 0 && hovered < data.length ? data[hovered] : null;

  return (
    <div>
      <div
        className="slim-scroll w-full overflow-x-auto overflow-y-hidden pb-1"
        role="img"
        aria-label={`${metric} time series`}
      >
        <div
          className="flex items-end gap-2 pt-2"
          style={{ minWidth: `${Math.max(data.length * 48, 120)}px` }}
        >
          {data.map((d, i) => {
            const h = d.value > 0 ? Math.max(6, (d.value / max) * barHeight) : 4;
            const isActive = hovered === i;
            return (
              <div
                key={`${d.labelFull}-${i}`}
                className="flex flex-1 cursor-default flex-col items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                  className={`truncate text-[11px] leading-none tabular-nums ${
                    isActive
                      ? "block font-semibold text-foreground"
                      : "hidden text-muted-foreground sm:block"
                  }`}
                >
                  {fmtLabel(d.value)}
                </span>
                <div
                  className="relative flex w-full max-w-[68px] items-end border-b border-border/80"
                  style={{ height: barHeight }}
                >
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-border/50"
                  />
                  <div
                    className={`bar-grow-y relative w-full rounded-t-[2px] ${
                      d.value > 0 ? fill : "bg-track"
                    } ${isActive ? "ring-2 ring-primary/60" : ""}`}
                    style={{ height: `${h}px`, animationDelay: `${i * 20}ms` }}
                  />
                </div>
                <span className="truncate text-[11px] leading-none text-muted-foreground">
                  {d.label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
      <p aria-live="polite" className="mt-2 min-h-4 text-xs tabular-nums text-muted-foreground">
        {active ? (
          <>
            <span className="font-medium text-foreground">{active.labelFull}</span>
            {" · "}
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

import { useState } from "react";

type DayPoint = { day: string; count: number };

type WeekSummary = {
  requests: number;
  ok: number;
  tokens: number;
};

type Props = {
  data: DayPoint[];
  summary?: WeekSummary;
};

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function UsageChart({ data, summary }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.count));
  const barHeight = 160;
  const active = hovered != null && hovered >= 0 && hovered < data.length ? data[hovered] : null;

  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">
          Usage — Last 7 days
        </h3>
        {summary ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
            <span>
              <span className="font-semibold tabular-nums text-foreground">
                {fmtCompact(summary.requests)}
              </span>{" "}
              requests
            </span>
            <span>
              <span className="font-semibold tabular-nums text-success">
                {fmtCompact(summary.ok)}
              </span>{" "}
              OK
            </span>
            <span>
              <span className="font-semibold tabular-nums text-foreground">
                {fmtCompact(summary.tokens)}
              </span>{" "}
              tokens
            </span>
          </p>
        ) : null}
      </div>

      {data.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No usage data yet.
        </p>
      ) : (
        <div className="w-full" role="img" aria-label="Usage bar chart, last 7 days">
          <div className="flex items-end gap-1.5">
            {data.map((d, i) => {
              const h =
                d.count > 0 ? Math.max(3, (d.count / max) * barHeight) : 3;
              const [, month, day] = d.day.split("-");
              const isActive = hovered === i;
              return (
                <div
                  key={d.day}
                  className="flex flex-1 cursor-default flex-col items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  tabIndex={0}
                  role="button"
                  aria-label={`${d.day}: ${d.count} request${d.count === 1 ? "" : "s"}`}
                  title={`${d.day}: ${d.count} request${d.count === 1 ? "" : "s"}`}
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
                    {d.count > 0 ? fmtCompact(d.count) : "0"}
                  </span>
                  <div className="flex w-full items-end" style={{ height: barHeight }}>
                    <div
                      className={`bar-grow-y w-full rounded-sm ${
                        d.count > 0 ? "bg-primary" : "bg-primary/15"
                      } ${isActive ? "ring-2 ring-foreground/60" : ""}`}
                      style={{ height: `${h}px`, animationDelay: `${i * 25}ms` }}
                    />
                  </div>
                  <span className="text-xs leading-none text-muted-foreground">
                    {day}/{month}
                  </span>
                </div>
              );
            })}
          </div>
          <p aria-live="polite" className="mt-2 min-h-4 text-xs tabular-nums text-muted-foreground">
            {active ? (
              <>
                <span className="font-medium text-foreground">{active.day}</span>
                {" — "}
                {active.count} request{active.count === 1 ? "" : "s"}
              </>
            ) : (
              <>Hover or tap a bar for exact values</>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

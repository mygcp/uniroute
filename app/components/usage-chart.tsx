import { useState, type ReactNode } from "react";

type DayPoint = { day: string; count: number };

type WeekSummary = {
  requests: number;
  ok: number;
  tokens: number;
};

type Props = {
  data: DayPoint[];
  summary?: WeekSummary;
  action?: ReactNode;
};

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function UsageChart({ data, summary, action }: Props) {
  const [hovered, setHovered] = useState<number | null>(null);
  const max = Math.max(1, ...data.map((d) => d.count));
  const totalInRange = data.reduce((sum, d) => sum + d.count, 0);
  const barHeight = 160;
  const active =
    hovered != null && hovered >= 0 && hovered < data.length ? data[hovered] : null;

  return (
    <div className="glass-panel p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-foreground">
            Requests and tokens, last 7 days
          </h2>
          {summary ? (
            <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
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
        {action}
      </div>

      {data.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          No usage data yet.
        </p>
      ) : (
        <div className="w-full" role="img" aria-label="Usage bar chart, last 7 days">
          <div className="flex items-end gap-2">
            {data.map((d, i) => {
              const h =
                d.count > 0 ? Math.max(6, (d.count / max) * barHeight) : 4;
              const [, month, day] = d.day.split("-");
              const isActive = hovered === i;
              return (
                <div
                  key={d.day}
                  className="flex flex-1 cursor-default flex-col items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
                      isActive
                        ? "block font-semibold text-foreground"
                        : "hidden text-muted-foreground sm:block"
                    }`}
                  >
                    {d.count > 0 ? fmtCompact(d.count) : "0"}
                  </span>
                  <div
                    className="relative flex w-full max-w-[64px] items-end border-b border-border/80"
                    style={{ height: barHeight }}
                  >
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 top-1/2 border-t border-dashed border-border/50"
                    />
                    <div
                      className={`bar-grow-y relative w-full rounded-t-[2px] transition-colors ${
                        d.count > 0
                          ? "bg-primary hover:bg-primary-solid-border"
                          : "bg-track"
                      } ${isActive ? "ring-2 ring-primary/60" : ""}`}
                      style={{ height: `${h}px`, animationDelay: `${i * 25}ms` }}
                    />
                  </div>
                  <span className="text-[11px] leading-none text-muted-foreground">
                    {day}/{month}
                  </span>
                </div>
              );
            })}
          </div>
          <p
            aria-live="polite"
            className="mt-3 min-h-4 text-xs tabular-nums text-muted-foreground"
          >
            {active ? (
              <>
                <span className="font-medium text-foreground">{active.day}</span>
                {" · "}
                {active.count.toLocaleString()} request{active.count === 1 ? "" : "s"}
              </>
            ) : totalInRange === 0 ? (
              <>No requests recorded in the last 7 days. Check Usage Analytics for earlier history.</>
            ) : (
              <>Hover or tap a bar for exact values</>
            )}
          </p>
        </div>
      )}
    </div>
  );
}

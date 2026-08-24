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
  const max = Math.max(1, ...data.map((d) => d.count));
  const barHeight = 160;

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
              return (
                <div
                  key={d.day}
                  className="flex flex-1 flex-col items-center gap-1"
                  title={`${d.day}: ${d.count} request${d.count === 1 ? "" : "s"}`}
                >
                  <span className="hidden text-[10px] leading-none tabular-nums text-muted-foreground sm:block">
                    {d.count > 0 ? fmtCompact(d.count) : "0"}
                  </span>
                  <div className="flex w-full items-end" style={{ height: barHeight }}>
                    <div
                      className={`bar-grow-y w-full rounded-sm ${
                        d.count > 0 ? "bg-primary" : "bg-primary/15"
                      }`}
                      style={{ height: `${h}px`, animationDelay: `${i * 25}ms` }}
                    />
                  </div>
                  <span className="text-[10px] leading-none text-muted-foreground">
                    {day}/{month}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

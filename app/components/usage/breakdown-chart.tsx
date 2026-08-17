import type { BreakdownEntry, Metric } from "../../.server/usage";

type Props = {
  data: BreakdownEntry[];
  metric: Metric;
};

function fmtValue(value: number, metric: Metric): string {
  if (metric === "cost") return `$${value.toFixed(2)}`;
  return `${value.toLocaleString()} tokens`;
}

function truncate(name: string, n = 20): string {
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
  const rowH = 44;
  const headerH = 20;
  const h = Math.max(80, data.length * rowH + headerH);
  const w = 800;
  const barMaxW = w * 0.6;
  const barX = 200;

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`${metric} breakdown`}>
      {data.map((d, i) => {
        const y = headerH + i * rowH;
        const bw = (d.value / max) * barMaxW;
        const fill = d.name === "Other" ? "#6b7280" : i % 2 === 0 ? "#3b82f6" : "#2563eb";
        return (
          <g key={`${d.name}-${i}`}>
            <text x={barX - 8} y={y + 14} textAnchor="end" fontSize="12" fill="#9ca3af">
              <title>{d.name}</title>
              {truncate(d.name)}
            </text>
            <rect x={barX} y={y + 2} width={Math.max(0, bw)} height={16} rx={3} fill={fill}>
              <title>{`${d.name}: ${fmtValue(d.value, metric)}`}</title>
            </rect>
            {bw > 40 ? (
              <text x={barX + bw - 6} y={y + 14} textAnchor="end" fontSize="11" fill="#fff">
                {d.pct}%
              </text>
            ) : (
              <text x={barX + bw + 4} y={y + 14} fontSize="11" fill="#9ca3af">
                {d.pct}%
              </text>
            )}
            <text
              x={barX + barMaxW + 12}
              y={y + 14}
              fontSize="11"
              fill="#9ca3af"
              className="tabular-nums"
            >
              {fmtValue(d.value, metric)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
import type { Metric, TimeSeriesPoint } from "../../.server/usage";

type Props = {
  data: TimeSeriesPoint[];
  metric: Metric;
  viewBox?: { w: number; h: number };
};

function fmtValue(value: number, metric: Metric): string {
  if (metric === "cost") return `$${value.toFixed(2)}`;
  return value.toLocaleString();
}

export function TimeSeriesChart({ data, metric, viewBox = { w: 900, h: 200 } }: Props) {
  const { w, h } = viewBox;
  const max = Math.max(1, ...data.map((d) => d.value));
  const barGap = 12;
  const barW = data.length > 0 ? (w - barGap * (data.length - 1)) / data.length : w;
  const fill = metric === "cost" ? "#10b981" : "#3b82f6";

  if (data.length === 0) {
    return (
      <div className="py-10 text-center text-sm text-muted-foreground">
        No data for this period
      </div>
    );
  }

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`${metric} time series`}>
      <line x1="0" y1={h - 20} x2={w} y2={h - 20} stroke="#4b5563" />
      {data.map((d, i) => {
        const x = i * (barW + barGap);
        const bh = d.value > 0 ? Math.max(1, (d.value / max) * (h - 40)) : 0;
        return (
          <g key={`${d.labelFull}-${i}`}>
            <rect
              x={x}
              y={h - 20 - bh}
              width={barW}
              height={bh}
              rx={3}
              fill={d.value > 0 ? fill : "#4b5563"}
            >
              <title>{`${d.labelFull}: ${fmtValue(d.value, metric)}`}</title>
            </rect>
            {bh > 5 ? (
              <text
                x={x + barW / 2}
                y={h - 26 - bh}
                textAnchor="middle"
                fontSize="9"
                fill="#9ca3af"
                className="tabular-nums"
              >
                {fmtValue(d.value, metric)}
              </text>
            ) : null}
            <text x={x + barW / 2} y={h - 6} textAnchor="middle" fontSize="9" fill="#9ca3af">
              {d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
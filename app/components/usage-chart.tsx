type Props = {
  data: { day: string; count: number }[];
};

export function UsageChart({ data }: Props) {
  const max = Math.max(1, ...data.map((d) => d.count));
  const width = 560;
  const height = 160;
  const barGap = 12;
  const barWidth = (width - barGap * (data.length - 1)) / data.length;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-semibold text-gray-700">Usage — 7 hari terakhir</h3>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Usage bar chart">
        <line x1="0" y1={height - 20} x2={width} y2={height - 20} stroke="#e5e7eb" />
        {data.map((d, i) => {
          const x = i * (barWidth + barGap);
          const h = (d.count / max) * (height - 40);
          return (
            <g key={d.day}>
              <rect
                x={x}
                y={height - 20 - h}
                width={barWidth}
                height={h}
                rx={3}
                fill={d.count > 0 ? "#2563eb" : "#e5e7eb"}
              >
                <title>{`${d.day}: ${d.count}`}</title>
              </rect>
              <text
                x={x + barWidth / 2}
                y={height - 6}
                textAnchor="middle"
                fontSize="9"
                fill="#9ca3af"
              >
                {d.day.slice(5)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
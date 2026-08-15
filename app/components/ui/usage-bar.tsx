const TONES = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export function UsageBar({
  value,
  max = 100,
  tone = "success",
}: {
  value: number;
  max?: number;
  tone?: "success" | "warning" | "danger";
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${TONES[tone]} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}
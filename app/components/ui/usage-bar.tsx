const TONES = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export function UsageBar({
  value,
  max = 100,
  tone = "success",
  label,
}: {
  value: number;
  max?: number;
  tone?: "success" | "warning" | "danger";
  label?: string;
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      className="h-1.5 w-full overflow-hidden rounded-full bg-track"
    >
      <div
        className={`h-full rounded-full ${TONES[tone]} transition-all duration-300`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

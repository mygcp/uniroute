import type { ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";

const ICON_TONE: Record<string, string> = {
  "bg-primary": "bg-primary/12 text-primary border-primary/20",
  "bg-success": "bg-success/12 text-success border-success/20",
  "bg-warning": "bg-warning/12 text-warning border-warning/20",
  "bg-danger": "bg-danger/12 text-danger border-danger/20",
  "bg-info": "bg-info/12 text-info border-info/20",
};

export function StatCard({
  title,
  value,
  suffix,
  accent = "bg-primary",
  icon,
  delta,
  deltaSuffix = "%",
  subline,
}: {
  title: string;
  value: string | number;
  suffix?: string;
  accent?: string;
  icon?: ReactNode;
  delta?: { value: number | null; good: boolean };
  deltaSuffix?: string;
  subline?: string;
}) {
  const isUp = delta?.value == null ? null : delta.value >= 0;
  const isFlat = delta?.value === 0;
  const tone =
    isUp == null || isFlat
      ? "text-muted-foreground"
      : isUp === delta!.good
        ? "text-success"
        : "text-danger";

  const iconTone = ICON_TONE[accent] ?? "bg-surface-2 text-muted-foreground border-border";

  return (
    <div className="glass-panel relative overflow-hidden p-4 sm:p-5">
      <div className={`absolute inset-x-0 top-0 h-[2px] ${accent} opacity-80`} />
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {title}
        </p>
        {icon ? (
          <span
            className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${iconTone}`}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight tabular-nums text-foreground sm:text-[26px]">
        {value}
        {suffix ? (
          <span className="ml-1 text-sm font-medium text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {delta ? (
          <span
            className={`inline-flex items-center gap-1 rounded-full border border-border bg-surface-2/80 px-2 py-0.5 text-xs font-medium tabular-nums ${tone}`}
          >
            {isUp == null ? (
              <span>-</span>
            ) : isFlat ? (
              <span>0{deltaSuffix}</span>
            ) : (
              <>
                {isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
                <span>
                  {delta.value! >= 0 ? "+" : ""}
                  {delta.value!}
                  {deltaSuffix}
                </span>
              </>
            )}
          </span>
        ) : null}
        {subline ? (
          <p className="text-xs text-muted-foreground">{subline}</p>
        ) : null}
      </div>
    </div>
  );
}

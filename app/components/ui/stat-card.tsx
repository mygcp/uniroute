import type { ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";

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

  return (
    <div className="glass-panel p-4 transition hover:-translate-y-0.5 hover:border-primary/30 sm:p-5">
      <div className="mb-3 flex items-center justify-between">
        <div className={`h-1 w-10 rounded-full ${accent}`} />
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
        {value}
        {suffix ? <span className="ml-1 text-sm font-medium text-muted-foreground">{suffix}</span> : null}
      </p>
      {delta ? (
        <p className={`mt-1.5 flex items-center gap-1 text-xs font-medium tabular-nums ${tone}`}>
          {isUp == null ? (
            <span>—</span>
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
        </p>
      ) : null}
      {subline ? <p className="mt-1 text-xs text-muted-foreground">{subline}</p> : null}
    </div>
  );
}
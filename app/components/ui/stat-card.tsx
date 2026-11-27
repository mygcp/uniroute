import type { ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";

export function StatCard({
  title,
  value,
  suffix,
  accent: _accent,
  icon: _icon,
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
    <div className="rounded-lg border border-border bg-surface p-4">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <p className="mt-1.5 text-2xl font-bold tracking-tight tabular-nums text-foreground">
        {value}
        {suffix ? (
          <span className="ml-1 text-sm font-medium text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </p>
      {(delta || subline) ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          {delta ? (
            <span
              className={`inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.5 text-xs font-medium tabular-nums ${tone}`}
            >
              {isUp == null ? (
                <span>-</span>
              ) : isFlat ? (
                <span>0{deltaSuffix}</span>
              ) : (
                <>
                  {isUp ? <TrendingUp size={12} aria-hidden="true" /> : <TrendingDown size={12} aria-hidden="true" />}
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
      ) : null}
    </div>
  );
}

export type MetricItem = {
  label: string;
  value: string | number;
  suffix?: string;
  detail?: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
};

const VALUE_TONE: Record<NonNullable<MetricItem["tone"]>, string> = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  info: "text-info",
};

export function MetricStrip({
  items,
  className = "",
}: {
  items: MetricItem[];
  className?: string;
}) {
  const colsClass =
    items.length <= 2
      ? "sm:grid-cols-2"
      : items.length === 3
        ? "sm:grid-cols-3"
        : items.length === 4
          ? "sm:grid-cols-2 lg:grid-cols-4"
          : "sm:grid-cols-2 lg:grid-cols-3";

  return (
    <div
      className={[
        "grid grid-cols-1 divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface sm:divide-x sm:divide-y-0",
        colsClass,
        className,
      ].join(" ")}
    >
      {items.map((item) => (
        <div key={item.label} className="px-4 py-3.5">
          <p className="text-xs font-medium text-muted-foreground">{item.label}</p>
          <p
            className={`mt-1 text-xl font-bold tracking-tight tabular-nums sm:text-2xl ${
              VALUE_TONE[item.tone ?? "default"]
            }`}
          >
            {item.value}
            {item.suffix ? (
              <span className="ml-1 text-sm font-medium text-muted-foreground">
                {item.suffix}
              </span>
            ) : null}
          </p>
          {item.detail ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

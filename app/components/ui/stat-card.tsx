import type { ReactNode } from "react";

export function StatCard({
  title,
  value,
  suffix,
  accent = "bg-primary",
  icon,
}: {
  title: string;
  value: string | number;
  suffix?: string;
  accent?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className={`h-1 w-10 rounded-full ${accent}`} />
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
        {value}
        {suffix ? <span className="ml-1 text-sm font-medium text-muted-foreground">{suffix}</span> : null}
      </p>
    </div>
  );
}
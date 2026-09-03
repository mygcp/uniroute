import type { ReactNode } from "react";

export function PageHeader({
  title,
  icon,
  subtitle,
  actions,
}: {
  title: string;
  icon?: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-2.5">
        {icon ? <span className="shrink-0 text-foreground">{icon}</span> : null}
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-foreground">{title}</h1>
          {subtitle ? <p className="mt-0.5 break-words text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}
import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowLeft } from "lucide-react";

export function PageHeader({
  title,
  icon: _icon,
  subtitle,
  actions,
  backTo,
  backLabel = "Back",
  badge,
}: {
  title: string;
  icon?: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
  backTo?: string;
  backLabel?: string;
  badge?: ReactNode;
}) {
  return (
    <div className="mb-6 border-b border-border pb-4">
      {backTo ? (
        <Link
          to={backTo}
          prefetch="intent"
          className="mb-2 inline-flex min-h-[36px] items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          {backLabel}
        </Link>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[clamp(1.25rem,1.1rem+0.7vw,1.625rem)] font-bold tracking-tight text-foreground">
              {title}
            </h1>
            {badge}
          </div>
          {subtitle ? (
            <p className="mt-1 max-w-2xl break-words text-sm text-muted-foreground">
              {subtitle}
            </p>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

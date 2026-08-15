import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
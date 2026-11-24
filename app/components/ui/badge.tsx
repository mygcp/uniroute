import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";
export type BadgeStyle = "solid" | "subtle";

const SOLID: Record<BadgeTone, string> = {
  neutral: "border border-border bg-surface-2 text-foreground",
  success: "border border-success-solid bg-success-solid text-white",
  warning: "border border-warning-solid bg-warning-solid text-white",
  danger: "border border-danger-solid bg-danger-solid text-white",
  info: "border border-info-solid bg-info-solid text-white",
  primary: "border border-primary-solid-border bg-primary-solid text-primary-foreground",
};

const SUBTLE: Record<BadgeTone, string> = {
  neutral: "border border-border bg-surface-2 text-muted-foreground",
  success: "border border-success/25 bg-success/12 text-success",
  warning: "border border-warning/25 bg-warning/12 text-warning",
  danger: "border border-danger/25 bg-danger/12 text-danger",
  info: "border border-info/25 bg-info/12 text-info",
  primary: "border border-primary/25 bg-primary/12 text-primary",
};

export function Badge({
  tone = "neutral",
  style = "subtle",
  dot = false,
  className = "",
  children,
  ...rest
}: Omit<HTMLAttributes<HTMLSpanElement>, "style"> & {
  tone?: BadgeTone;
  style?: BadgeStyle;
  dot?: boolean;
}) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium leading-tight",
        style === "solid" ? SOLID[tone] : SUBTLE[tone],
        className,
      ].join(" ")}
      {...rest}
    >
      {dot ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

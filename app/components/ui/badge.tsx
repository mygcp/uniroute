import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";
export type BadgeStyle = "solid" | "subtle";

const SOLID: Record<BadgeTone, string> = {
  neutral: "bg-muted text-foreground",
  success: "bg-success/80 text-white",
  warning: "bg-warning/80 text-white",
  danger: "bg-danger/80 text-white",
  info: "bg-info/80 text-white",
  primary: "bg-primary/80 text-primary-foreground",
};

const SUBTLE: Record<BadgeTone, string> = {
  neutral: "border border-glass-border bg-glass-strong text-muted-foreground",
  success: "border border-success/25 bg-success/15 text-success",
  warning: "border border-warning/25 bg-warning/15 text-warning",
  danger: "border border-danger/25 bg-danger/15 text-danger",
  info: "border border-info/25 bg-info/15 text-info",
  primary: "border border-primary/25 bg-primary/15 text-primary",
};

export function Badge({
  tone = "neutral",
  style = "subtle",
  className = "",
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; style?: BadgeStyle }) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        style === "solid" ? SOLID[tone] : SUBTLE[tone],
        className,
      ].join(" ")}
      {...rest}
    />
  );
}
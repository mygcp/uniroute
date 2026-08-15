import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";
export type BadgeStyle = "solid" | "subtle";

const SOLID: Record<BadgeTone, string> = {
  neutral: "bg-muted text-foreground",
  success: "bg-success text-white",
  warning: "bg-warning text-white",
  danger: "bg-danger text-white",
  info: "bg-info text-white",
  primary: "bg-primary text-primary-foreground",
};

const SUBTLE: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  primary: "bg-primary/15 text-primary",
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
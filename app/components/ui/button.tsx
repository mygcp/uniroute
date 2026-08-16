import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary: "border border-primary/25 bg-primary/15 text-primary hover:bg-primary/25",
  secondary: "border border-glass-border bg-glass-strong text-foreground hover:bg-glass-hover",
  ghost: "text-muted-foreground hover:bg-glass-hover hover:text-foreground",
  danger: "border border-danger/25 bg-danger/15 text-danger hover:bg-danger/25",
  outline: "border border-glass-border bg-glass text-foreground hover:bg-glass-hover",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  icon: "h-8 w-8",
};

export type ButtonVariant = Variant;
export type ButtonSize = Size;

export function buttonClass(
  variant: Variant = "primary",
  size: Size = "md",
  extra = "",
): string {
  return [
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium shadow-[inset_0_1px_0_var(--glass-highlight)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
    extra,
  ]
    .join(" ")
    .trim();
}

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
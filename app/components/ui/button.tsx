import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "danger-solid" | "outline";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary:
    "border border-primary-solid-border bg-primary-solid text-primary-foreground hover:bg-primary-solid-hover active:bg-primary-solid-hover",
  secondary:
    "border border-border bg-surface-2 text-foreground hover:border-border-strong hover:bg-muted",
  outline:
    "border border-border bg-surface text-foreground hover:border-border-strong hover:bg-surface-2",
  ghost:
    "border border-transparent bg-transparent text-muted-foreground hover:bg-surface-2 hover:text-foreground",
  danger:
    "border border-danger/40 bg-danger/10 text-danger hover:border-danger-solid hover:bg-danger-solid hover:text-white",
  "danger-solid":
    "border border-danger-solid bg-danger-solid text-white hover:border-danger-solid-hover hover:bg-danger-solid-hover active:bg-danger-solid-hover",
};

const SIZES: Record<Size, string> = {
  sm: "min-h-[44px] sm:min-h-[32px] px-3 text-xs",
  md: "min-h-[44px] sm:min-h-[36px] px-3.5 text-sm",
  icon: "min-h-[44px] min-w-[44px] sm:min-h-[34px] sm:min-w-[34px] p-0",
};

export type ButtonVariant = Variant;
export type ButtonSize = Size;

export function buttonClass(
  variant: Variant = "primary",
  size: Size = "md",
  extra = "",
): string {
  return [
    "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45",
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
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      {...rest}
    />
  );
}

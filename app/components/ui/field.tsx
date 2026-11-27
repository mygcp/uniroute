import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const base =
  "w-full rounded-md border border-border bg-surface px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/75 hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50";
const invalidBase =
  "border-danger/70 data-[invalid=true]:border-danger data-[invalid=true]:focus:border-danger";

export function Label({
  className = "",
  ...rest
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={[
        "mb-1.5 block text-xs font-medium text-muted-foreground",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
  controlSize?: "sm" | "md";
};

export function Input({
  invalid,
  controlSize = "md",
  className = "",
  ...rest
}: InputProps) {
  const sizeClass =
    controlSize === "sm"
      ? "min-h-[44px] sm:min-h-[32px] text-xs"
      : "min-h-[44px] sm:min-h-[36px] text-sm";
  return (
    <input
      data-invalid={invalid ? "true" : undefined}
      aria-invalid={invalid || undefined}
      className={[base, invalid ? invalidBase : "", sizeClass, className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function Textarea({
  invalid,
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      data-invalid={invalid ? "true" : undefined}
      aria-invalid={invalid || undefined}
      className={[base, invalid ? invalidBase : "", "py-2", className]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function Select({
  invalid,
  controlSize = "md",
  className = "",
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  invalid?: boolean;
  controlSize?: "sm" | "md";
}) {
  const sizeClass =
    controlSize === "sm"
      ? "min-h-[44px] sm:min-h-[32px] py-1 text-xs"
      : "min-h-[44px] sm:min-h-[36px] py-1.5 text-sm";
  return (
    <select
      data-invalid={invalid ? "true" : undefined}
      aria-invalid={invalid || undefined}
      className={[
        base,
        invalid ? invalidBase : "",
        "ui-select bg-surface",
        sizeClass,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function Checkbox({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={[
        "h-4 w-4 shrink-0 rounded-[4px] border border-border-strong bg-surface accent-primary-solid transition-colors",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

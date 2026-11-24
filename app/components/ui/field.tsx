import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const base =
  "w-full rounded-lg border border-border bg-surface px-3 text-sm text-foreground transition-colors placeholder:text-muted-foreground/75 hover:border-border-strong focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/25 disabled:opacity-50";
const invalidBase =
  "border-danger/65 data-[invalid=true]:border-danger data-[invalid=true]:focus:border-danger data-[invalid=true]:focus:ring-danger/25";

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
  const sizeClass = controlSize === "sm" ? "h-8 text-xs" : "h-9 text-sm";
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
      ? "h-8 text-xs leading-[1.875rem]"
      : "h-9 text-sm leading-[2.125rem]";
  return (
    <select
      data-invalid={invalid ? "true" : undefined}
      aria-invalid={invalid || undefined}
      className={[
        base,
        invalid ? invalidBase : "",
        "ui-select py-0 bg-surface",
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
        "h-4 w-4 rounded border border-border-strong bg-surface accent-primary-solid",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

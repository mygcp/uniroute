import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const base =
  "w-full rounded-lg border border-glass-border bg-glass-strong px-3 text-sm text-foreground backdrop-blur-sm shadow-[inset_0_1px_0_var(--glass-highlight)] transition-colors placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50";
const invalidBase =
  "border-danger/40 data-[invalid=true]:border-danger/60 data-[invalid=true]:focus:border-danger data-[invalid=true]:focus:ring-danger/25";

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
};

export function Input({ invalid, className = "", ...rest }: InputProps) {
  return (
    <input
      data-invalid={invalid ? "true" : undefined}
      className={[
        base,
        invalid ? invalidBase : "",
        "h-9",
        className,
      ].join(" ")}
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
      className={[base, invalid ? invalidBase : "", "py-2", className].join(" ")}
      {...rest}
    />
  );
}

export function Select({
  invalid,
  className = "",
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      data-invalid={invalid ? "true" : undefined}
      className={[base, invalid ? invalidBase : "", "h-9", className].join(" ")}
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
        "h-4 w-4 rounded border border-glass-border bg-glass-strong accent-primary",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}
import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const base =
  "w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50";
const invalidBase =
  "border-danger data-[invalid=true]:border-danger data-[invalid=true]:focus:border-danger data-[invalid=true]:focus:ring-danger/40";

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
        "h-4 w-4 rounded border-border bg-surface-2 accent-primary",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}
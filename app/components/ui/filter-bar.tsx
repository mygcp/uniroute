import { useRef, type InputHTMLAttributes, type ReactNode } from "react";
import { Search, X } from "lucide-react";

export function FilterBar({
  variant = "standalone",
  className = "",
  children,
}: {
  variant?: "standalone" | "embedded";
  className?: string;
  children: ReactNode;
}) {
  const base =
    variant === "embedded"
      ? "flex flex-col gap-2.5 border-b border-border bg-surface-2/40 px-4 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between"
      : "mb-4 flex flex-col gap-2.5 rounded-lg border border-border bg-surface p-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between";
  return <div className={[base, className].filter(Boolean).join(" ")}>{children}</div>;
}

export function FilterGroup({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={["flex min-w-0 flex-1 flex-wrap items-center gap-2", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export function FilterActions({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={["flex min-w-0 max-w-full flex-wrap items-center gap-2", className].filter(Boolean).join(" ")}>
      {children}
    </div>
  );
}

export type SearchInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "onChange" | "size" | "value"
> & {
  value: string;
  onChange: (value: string) => void;
  controlSize?: "sm" | "md";
  containerClassName?: string;
  clearLabel?: string;
};

export function SearchInput({
  value,
  onChange,
  controlSize = "md",
  containerClassName = "",
  clearLabel = "Clear search",
  className = "",
  onKeyDown,
  ...rest
}: SearchInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const sizeClass =
    controlSize === "sm"
      ? "min-h-[44px] sm:min-h-[32px] text-xs"
      : "min-h-[44px] sm:min-h-[36px] text-sm";

  return (
    <div className={["relative", containerClassName].filter(Boolean).join(" ")}>
      <Search
        className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value.length > 0) {
            e.preventDefault();
            onChange("");
          }
          onKeyDown?.(e);
        }}
        className={[
          "w-full rounded-md border border-border bg-surface pl-8 pr-8 text-foreground transition-colors placeholder:text-muted-foreground/75 hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50",
          sizeClass,
          className,
        ]
          .filter(Boolean)
          .join(" ")}
        {...rest}
      />
      {value.length > 0 ? (
        <button
          type="button"
          onClick={() => {
            onChange("");
            inputRef.current?.focus();
          }}
          aria-label={clearLabel}
          className="absolute top-1/2 right-1.5 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground sm:h-6 sm:w-6"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
  className = "",
}: {
  options: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={[
        "inline-flex flex-wrap items-center rounded-md border border-border bg-surface-2 p-0.5",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={[
              "inline-flex min-h-[40px] items-center rounded-[4px] border px-2.5 text-xs font-medium transition-colors sm:min-h-[28px]",
              active
                ? "border-border-strong bg-surface text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            <span>{opt.label}</span>
            {opt.count !== undefined ? (
              <span className="ml-1.5 font-mono text-[11px] tabular-nums opacity-75">
                {opt.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

type CellAlign = "left" | "right" | "center";

const ALIGN_CLASS: Record<CellAlign, string> = {
  left: "text-left",
  right: "text-right",
  center: "text-center",
};

export function Table({
  className = "",
  containerClassName = "",
  ...rest
}: HTMLAttributes<HTMLTableElement> & { containerClassName?: string }) {
  return (
    <div className={["table-wrap", containerClassName].filter(Boolean).join(" ")}>
      <table className={["w-full text-left text-sm", className].join(" ")} {...rest} />
    </div>
  );
}

export function THead({
  sticky = false,
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableSectionElement> & { sticky?: boolean }) {
  return (
    <thead
      className={[
        "border-b border-border bg-surface-2/70 text-xs font-medium text-muted-foreground",
        sticky ? "sticky top-0 z-10 backdrop-blur-sm" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function THeadCell({
  align,
  numeric = false,
  className = "",
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & {
  align?: CellAlign;
  numeric?: boolean;
}) {
  const resolvedAlign = align ?? (numeric ? "right" : "left");
  return (
    <th
      scope="col"
      className={[
        "whitespace-nowrap px-3 py-2.5 font-medium first:pl-4 last:pr-4",
        ALIGN_CLASS[resolvedAlign],
        numeric ? "tabular-nums" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function TRow({
  selected = false,
  interactive = false,
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & {
  selected?: boolean;
  interactive?: boolean;
}) {
  return (
    <tr
      aria-selected={selected || undefined}
      className={[
        "border-b border-border/70 transition-colors last:border-b-0",
        selected ? "bg-primary/10 hover:bg-primary/14" : "hover:bg-surface-2/55",
        interactive ? "cursor-pointer" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

export function TCell({
  align,
  numeric = false,
  className = "",
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & {
  align?: CellAlign;
  numeric?: boolean;
}) {
  const resolvedAlign = align ?? (numeric ? "right" : "left");
  return (
    <td
      className={[
        "px-3 py-2.5 align-middle first:pl-4 last:pr-4",
        ALIGN_CLASS[resolvedAlign],
        numeric ? "tabular-nums" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      {...rest}
    />
  );
}

import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";

export function Table({ className = "", ...rest }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="table-wrap">
      <table className={["w-full text-left text-sm", className].join(" ")} {...rest} />
    </div>
  );
}

export function THead({ className = "", ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={[
        "border-b border-glass-border bg-surface-2/50 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export function THeadCell({ className = "", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={["py-2.5 pr-4 font-semibold first:pl-4 last:pr-4", className].join(" ")}
      {...rest}
    />
  );
}

export function TRow({ className = "", ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={[
        "border-b border-glass-border/70 transition-colors last:border-b-0 hover:bg-glass-hover",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export function TCell({ className = "", ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td
      className={["py-3 pr-4 first:pl-4 last:pr-4", className].join(" ")}
      {...rest}
    />
  );
}

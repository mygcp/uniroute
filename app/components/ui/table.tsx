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
      className={["border-b border-glass-border text-xs uppercase tracking-wide text-muted-foreground", className].join(" ")}
      {...rest}
    />
  );
}

export function THeadCell({ className = "", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={["py-2 pr-4 font-medium", className].join(" ")} {...rest} />;
}

export function TRow({ className = "", ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={["border-b border-glass-border transition-colors hover:bg-glass", className].join(" ")} {...rest} />;
}

export function TCell({ className = "", ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={["py-2.5 pr-4", className].join(" ")} {...rest} />;
}
import { useId, type ReactNode } from "react";

export function Tooltip({
  label,
  side = "top",
  align = "center",
  children,
}: {
  label: string;
  side?: "top" | "bottom";
  align?: "center" | "start" | "end";
  children: ReactNode;
}) {
  const tipId = useId();

  const sideClass = side === "bottom" ? "top-full mt-2" : "bottom-full mb-2";
  const alignClass =
    align === "end"
      ? "right-0"
      : align === "start"
        ? "left-0"
        : "left-1/2 -translate-x-1/2";

  return (
    <span className="group/tip relative inline-flex" aria-describedby={tipId}>
      {children}
      <span
        id={tipId}
        role="tooltip"
        className={`pointer-events-none absolute z-[80] whitespace-nowrap rounded-lg border border-border-strong bg-surface px-2.5 py-1 text-xs font-medium text-foreground opacity-0 shadow-lg transition-opacity duration-150 group-hover/tip:opacity-100 group-focus-within/tip:opacity-100 ${sideClass} ${alignClass}`}
      >
        {label}
      </span>
    </span>
  );
}

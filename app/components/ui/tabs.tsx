import { useRef } from "react";

export function Tabs({
  tabs,
  active,
  onChange,
  className = "",
}: {
  tabs: string[];
  active: string;
  onChange: (tab: string) => void;
  className?: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    if (next == null) return;
    e.preventDefault();
    refs.current[tabs[next]]?.focus();
    onChange(tabs[next]);
  };

  return (
    <div
      role="tablist"
      className={[
        "tabs-scroll inline-flex max-w-full rounded-md border border-border bg-surface-2 p-1",
        className,
      ].join(" ")}
    >
      {tabs.map((tab, i) => {
        const selected = tab === active;
        return (
          <button
            key={tab}
            ref={(el) => {
              refs.current[tab] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={[
              "shrink-0 cursor-pointer rounded px-3 py-1.5 min-h-[44px] sm:min-h-[30px] text-sm font-medium transition-colors",
              selected
                ? "border border-border-strong bg-surface text-foreground"
                : "border border-transparent text-muted-foreground hover:text-foreground",
            ].join(" ")}
          >
            {tab}
          </button>
        );
      })}
    </div>
  );
}

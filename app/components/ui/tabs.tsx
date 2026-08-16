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
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (i + dir + tabs.length) % tabs.length;
    refs.current[tabs[next]]?.focus();
    onChange(tabs[next]);
  };

  return (
    <div role="tablist" className={["tabs-scroll", className].join(" ")}>
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
              "shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97]",
              selected
                ? "border border-glass-border bg-glass-strong text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]"
                : "text-muted-foreground hover:bg-glass hover:text-foreground",
            ].join(" ")}
          >
            {tab}
          </button>
        );
      })}
    </div>
  );
}
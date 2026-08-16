import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

type ComboboxProps = {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
};

const Dropdown = memo(function Dropdown({
  options,
  highlight,
  open,
  onSelect,
}: {
  options: string[];
  highlight: number;
  open: boolean;
  onSelect: (opt: string) => void;
}) {
  return (
    <ul
      role="listbox"
      className={`absolute z-20 mt-1 max-h-48 w-full origin-top overflow-auto rounded-lg border border-border bg-surface-2 py-1 text-sm shadow-lg transition-[transform,opacity] duration-100 ${
        open
          ? "scale-y-100 opacity-100"
          : "pointer-events-none scale-y-90 opacity-0"
      }`}
    >
      {options.map((opt, i) => (
        <li key={opt} id={`option-${i}`} role="option" aria-selected={i === highlight}>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onSelect(opt)}
            className={`block w-full px-3 py-1.5 text-left text-foreground hover:bg-muted ${
              i === highlight ? "bg-muted" : ""
            }`}
          >
            {opt}
          </button>
        </li>
      ))}
    </ul>
  );
});

export function Combobox({
  options,
  value,
  onChange,
  id,
  name,
  placeholder,
  required,
  className,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const closeTimerRef = useRef<number | null>(null);

  const query = value.trim().toLowerCase();
  const filtered = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(query)).slice(0, 20),
    [options, query],
  );

  const openDropdown = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setOpen(true);
  }, []);

  const closeDropdown = useCallback(() => {
    if (!openRef.current) return;
    setClosing(true);
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setClosing(false);
    }, 100);
  }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closeDropdown();
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [closeDropdown]);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

  const select = useCallback(
    (opt: string) => {
      onChange(opt);
      closeDropdown();
    },
    [onChange, closeDropdown],
  );

  const showDropdown = open || closing;

  return (
    <div ref={rootRef} className="relative">
      <input
        id={id}
        name={name}
        value={value}
        placeholder={placeholder}
        required={required}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-activedescendant={open && filtered.length > 0 ? `option-${highlight}` : undefined}
        onFocus={openDropdown}
        onChange={(e) => {
          onChange(e.target.value);
          openDropdown();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (!open) {
              openDropdown();
              return;
            }
            e.preventDefault();
            setHighlight((h) =>
              e.key === "ArrowDown"
                ? Math.min(h + 1, filtered.length - 1)
                : Math.max(h - 1, 0),
            );
          } else if (e.key === "Enter") {
            if (open && filtered[highlight] !== undefined) {
              e.preventDefault();
              select(filtered[highlight]);
            }
          } else if (e.key === "Escape") {
            closeDropdown();
          }
        }}
        className={className}
      />
      {showDropdown && filtered.length > 0 ? (
        <Dropdown options={filtered} highlight={highlight} open={open} onSelect={select} />
      ) : null}
    </div>
  );
}
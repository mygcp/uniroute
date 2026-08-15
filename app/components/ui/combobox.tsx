import { useEffect, useRef, useState } from "react";

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
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const query = value.trim().toLowerCase();
  const filtered = options.filter((o) => o.toLowerCase().includes(query)).slice(0, 20);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  useEffect(() => {
    setHighlight(0);
  }, [query]);

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
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (!open) {
              setOpen(true);
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
              onChange(filtered[highlight]);
              setOpen(false);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        className={className}
      />
      {open && filtered.length > 0 ? (
        <ul
          role="listbox"
          className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-border bg-surface-2 py-1 text-sm shadow-lg"
        >
          {filtered.map((opt, i) => (
            <li key={opt} id={`option-${i}`} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(opt);
                  setOpen(false);
                }}
                className={`block w-full px-3 py-1.5 text-left text-foreground hover:bg-muted ${
                  i === highlight ? "bg-muted" : ""
                }`}
              >
                {opt}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
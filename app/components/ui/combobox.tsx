import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, X } from "lucide-react";

type ComboboxProps = {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  emptyLabel?: string;
  className?: string;
};

const Dropdown = memo(function Dropdown({
  listboxId,
  optionPrefix,
  options,
  value,
  highlight,
  open,
  emptyLabel,
  onSelect,
}: {
  listboxId: string;
  optionPrefix: string;
  options: string[];
  value: string;
  highlight: number;
  open: boolean;
  emptyLabel: string;
  onSelect: (opt: string) => void;
}) {
  return (
    <ul
      id={listboxId}
      role="listbox"
      className={`slim-scroll absolute left-0 z-50 mt-1.5 max-h-56 min-w-full w-max max-w-[min(24rem,90vw)] origin-top overflow-auto rounded-lg border border-border-strong bg-surface py-1 text-sm shadow-xl transition-[transform,opacity] duration-100 ${
        open
          ? "scale-y-100 opacity-100"
          : "pointer-events-none scale-y-95 opacity-0"
      }`}
    >
      {options.length === 0 ? (
        <li className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</li>
      ) : (
        options.map((opt, i) => {
          const isHighlighted = i === highlight;
          const isSelected = opt === value;
          return (
            <li
              key={opt}
              id={`${optionPrefix}-${i}`}
              role="option"
              aria-selected={isSelected}
            >
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSelect(opt)}
                className={`flex min-h-[40px] w-full cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-2 sm:min-h-[32px] ${
                  isHighlighted
                    ? "bg-primary/12 text-foreground"
                    : "text-foreground"
                }`}
              >
                <span className="truncate">{opt}</span>
                {isSelected ? (
                  <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                ) : null}
              </button>
            </li>
          );
        })
      )}
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
  disabled = false,
  clearable = true,
  emptyLabel = "No matching options",
  className,
}: ComboboxProps) {
  const uid = useId();
  const listboxId = `${uid}-listbox`;
  const optionPrefix = `${uid}-opt`;
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const closeTimerRef = useRef<number | null>(null);

  const query = value.trim().toLowerCase();
  const filtered = useMemo(
    () => options.filter((o) => o.toLowerCase().includes(query)).slice(0, 30),
    [options, query],
  );

  const openDropdown = useCallback(() => {
    if (disabled) return;
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setOpen(true);
  }, [disabled]);

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

  const showDropdown = (open || closing) && (filtered.length > 0 || query.length > 0);
  const showClear = clearable && value.length > 0 && !disabled;

  return (
    <div ref={rootRef} className="relative">
      <input
        ref={inputRef}
        id={id}
        name={name}
        value={value}
        placeholder={placeholder}
        required={required}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={showDropdown ? listboxId : undefined}
        aria-activedescendant={
          open && filtered.length > 0 ? `${optionPrefix}-${highlight}` : undefined
        }
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
                ? Math.min(h + 1, Math.max(0, filtered.length - 1))
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
        className={
          className ??
          "min-h-[44px] w-full rounded-md border border-border bg-surface pl-3 pr-14 text-sm text-foreground transition-colors placeholder:text-muted-foreground/75 hover:border-border-strong focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50 sm:min-h-[36px]"
        }
      />
      <div className="pointer-events-none absolute inset-y-0 right-1.5 flex items-center gap-0.5">
        {showClear ? (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Clear selection"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              onChange("");
              inputRef.current?.focus();
              openDropdown();
            }}
            className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
        <button
          type="button"
          tabIndex={-1}
          aria-label="Toggle options"
          disabled={disabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open) closeDropdown();
            else {
              inputRef.current?.focus();
              openDropdown();
            }
          }}
          className="pointer-events-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      </div>
      {showDropdown ? (
        <Dropdown
          listboxId={listboxId}
          optionPrefix={optionPrefix}
          options={filtered}
          value={value}
          highlight={highlight}
          open={open}
          emptyLabel={emptyLabel}
          onSelect={select}
        />
      ) : null}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border transition-colors before:absolute before:-inset-2.5 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-50 sm:before:inset-0",
        checked
          ? "border-primary-solid-border bg-primary-solid"
          : "border-border-strong bg-surface-2 hover:border-primary/50",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block h-3.5 w-3.5 transform rounded-full shadow-sm transition-transform",
          checked
            ? "translate-x-[17px] bg-white"
            : "translate-x-[2px] bg-muted-foreground",
        ].join(" ")}
      />
    </button>
  );
}

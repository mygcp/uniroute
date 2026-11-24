import { useEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  disabled?: boolean;
  placeholder?: string;
  maxHeight?: number;
  embedded?: boolean;
  id?: string;
  ariaLabel?: string;
};

/**
 * Auto-growing message input: expands up to `maxHeight`, then scrolls.
 * Enter sends, Shift+Enter inserts a new line.
 */
export function MessageInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder = "Message...",
  maxHeight = 180,
  embedded = false,
  id,
  ariaLabel = "Chat message",
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);

  return (
    <textarea
      ref={ref}
      id={id}
      aria-label={ariaLabel}
      rows={embedded ? 2 : 1}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
          e.preventDefault();
          if (!disabled && value.trim()) onSubmit?.();
        }
      }}
      placeholder={placeholder}
      className={
        embedded
          ? "slim-scroll block w-full resize-none bg-transparent px-3.5 pt-3 pb-1.5 text-sm leading-relaxed text-foreground placeholder:text-muted-foreground/75 focus:outline-none disabled:opacity-50"
          : "slim-scroll w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground transition-colors placeholder:text-muted-foreground/75 focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/25 disabled:opacity-50"
      }
      style={{ overflowY: "auto" }}
    />
  );
}

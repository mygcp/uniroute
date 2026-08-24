import { useEffect, useRef } from "react";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  disabled?: boolean;
  placeholder?: string;
  /** Tinggi maksimum sebelum scroll (px). */
  maxHeight?: number;
};

/**
 * Textarea auto-grow: tinggi mengikuti isi sampai `maxHeight`, lalu scroll.
 * Enter = kirim, Shift+Enter = baris baru.
 */
export function MessageInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder = "Message…",
  maxHeight = 160,
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
      rows={1}
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
      className="w-full resize-none rounded-lg border border-glass-border bg-glass-strong px-3 py-2 text-sm text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)] transition-colors placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-50"
      style={{ overflowY: "auto" }}
    />
  );
}

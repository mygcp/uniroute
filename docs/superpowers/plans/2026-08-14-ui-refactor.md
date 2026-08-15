# UI Refactor & Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor UniRoute's entire admin UI onto a shared, token-driven design system (dark-first, Linear/Vercel-style) with a hand-built UI kit, fixing all audited bugs and standardizing the UI to English.

**Architecture:** Tailwind v4 CSS variables (`@theme inline`) define semantic tokens; `:root` is dark, `.light` overrides. A zero-dependency UI kit in `app/components/ui/` consumes the tokens. All 23 route files + 6 existing components are refactored to use the kit. No new runtime dependencies.

**Tech Stack:** React Router v8, React 19, Tailwind CSS v4, lucide-react. Verification: `bun run typecheck`, `bun test`, `bun run build` (build not always required mid-plan; typecheck per task).

## Global Constraints

- **No new runtime dependencies.** Only `lucide-react` (already present) is allowed for icons.
- **Dark is the default.** `:root` holds dark values; a `.light` class on `<html>` opts into light mode. Existing `dark:` class variants are REMOVED as tokens replace them; do not add new `dark:` classes except where the old `html.dark` selector must be replaced by `.light`.
- **UI text is English only.** Remove all Indonesian strings (see audit list). Do not introduce Indonesian.
- **Component props must match exactly** the signatures defined in each task's Interfaces block — later tasks consume them by name.
- Every interactive element: `focus-visible` ring, `aria-*` where specified, `disabled` styling.
- Labels associate with controls via `htmlFor`/`id`.
- Commits after every task; message format `refactor: ...`, `fix: ...`, `feat: ...` matching repo style.
- Existing TypeScript strict mode — no `any`, no untyped `as` casts where avoidable.

---

## Phase 1 — Design tokens & theming

### Task 1: Design tokens in app.css

**Files:**
- Modify: `app/app.css`

**Interfaces:**
- Produces: Tailwind utilities `bg-background`, `bg-surface`, `bg-surface-2`, `border-border`, `text-foreground`, `text-muted`, `text-muted-foreground`, `bg-primary`, `text-primary-foreground`, `bg-success`, `bg-warning`, `bg-danger`, `bg-info`, `bg-muted`, `ring-primary`, `text-danger`, `text-success`, `text-warning`, `text-info`, `font-mono`, `tabular-nums`, plus `--radius-*` shadow tokens.

- [ ] **Step 1: Replace app.css with token system**

```css
@import "tailwindcss";

@custom-variant light (&:where(.light, .light *));

@theme inline {
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif,
    "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  --font-mono: ui-monospace, "SF Mono", "Cascadia Code", "JetBrains Mono", Menlo,
    Consolas, monospace;

  --color-background: var(--background);
  --color-surface: var(--surface);
  --color-surface-2: var(--surface-2);
  --color-border: var(--border);
  --color-foreground: var(--foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-success: var(--success);
  --color-warning: var(--warning);
  --color-danger: var(--danger);
  --color-info: var(--info);
  --color-ring: var(--ring);
}

:root {
  color-scheme: dark;
  --background: #09090b;
  --surface: #111113;
  --surface-2: #1a1a1f;
  --border: #26262b;
  --foreground: #f4f4f5;
  --muted: #27272a;
  --muted-foreground: #a1a1aa;
  --primary: #3b82f6;
  --primary-foreground: #ffffff;
  --success: #22c55e;
  --warning: #f59e0b;
  --danger: #ef4444;
  --info: #38bdf8;
  --ring: #3b82f6;
}

.light {
  color-scheme: light;
  --background: #ffffff;
  --surface: #ffffff;
  --surface-2: #f4f4f5;
  --border: #e4e4e7;
  --foreground: #18181b;
  --muted: #f4f4f5;
  --muted-foreground: #71717a;
  --primary: #2563eb;
  --primary-foreground: #ffffff;
  --success: #16a34a;
  --warning: #d97706;
  --danger: #dc2626;
  --info: #0284c7;
  --ring: #2563eb;
}

html,
body {
  @apply bg-background text-foreground;
  font-family: var(--font-sans);
}

/* Table wrapper for horizontal scroll */
.table-wrap {
  @apply w-full overflow-x-auto;
}

.table-wrap table {
  @apply min-w-max;
}

/* Mobile tabs: scrollable */
.tabs-scroll {
  @apply flex gap-2 overflow-x-auto pb-1 scrollbar-none;
}

.scrollbar-none {
  -ms-overflow-style: none;
  scrollbar-width: none;
}
.scrollbar-none::-webkit-scrollbar {
  display: none;
}

/* Slim custom scrollbars for log viewers / code panes */
.slim-scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--muted) transparent;
}
.slim-scroll::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.slim-scroll::-webkit-scrollbar-thumb {
  background: var(--muted);
  border-radius: 4px;
}
.slim-scroll::-webkit-scrollbar-track {
  background: transparent;
}

/* Page fade-in on route change */
@keyframes page-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.animate-page-in {
  animation: page-in 0.18s ease-out;
}
```

- [ ] **Step 2: Verify Tailwind compiles**

Run: `bun run typecheck`
Expected: PASS (no unused-token errors; Tailwind v4 accepts `@theme inline`).

- [ ] **Step 3: Commit**

```bash
git add app/app.css
git commit -m "style: token-driven dark-first design system in app.css"
```

---

### Task 2: Theme hook — default dark, `.light` class

**Files:**
- Modify: `app/lib/theme.ts`
- Modify: `app/hooks/use-theme.tsx`
- Modify: `app/root.tsx` (inline head script + `ThemedHtml` class)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ThemeProvider` applies `light` class on `<html>` when theme is light (no class when dark). `useTheme()` unchanged signature `{ theme, toggle, mounted }`. Head inline script must add `.light` when a stored `"light"` theme exists, else leave dark (default).

- [ ] **Step 1: Update head script + html class logic**

In `app/root.tsx`, replace the inline `<script>` `__html` and the `ThemedHtml` className logic. New script:
```html
(function(){try{var t=localStorage.getItem("uniroute-theme");if(t==="light"){document.documentElement.classList.add("light")}}catch(e){}})();
```
And `className={theme === "light" ? "light" : undefined}` on `<html>` (keep `suppressHydrationWarning`).

- [ ] **Step 2: Update ThemeProvider default**

In `app/hooks/use-theme.tsx`:
- Initial state: `useState<Theme>("dark")`.
- In the mount effect, replace the `stored ?? prefersDark` logic with `setTheme(stored ?? "dark")` (dark-first; ignore system preference).
- Toggle effect: `document.documentElement.classList.toggle("light", theme === "light")` and remove the `"dark"` toggling.

`app/lib/theme.ts` stays as-is (`THEME_KEY` unchanged, decode unchanged).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/lib/theme.ts app/hooks/use-theme.tsx app/root.tsx
git commit -m "refactor: dark-first theme default via .light class"
```

---

## Phase 2 — UI kit primitives

### Task 3: Button, Input, Textarea, Select, Checkbox, Label

**Files:**
- Create: `app/components/ui/button.tsx`
- Create: `app/components/ui/field.tsx` (Input, Textarea, Select, Checkbox, Label)

**Interfaces:**
- Consumes: tokens from Task 1.
- Produces:

```tsx
// button.tsx
type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md" | "icon";
};
export function Button(props: ButtonProps): React.JSX.Element;
```

```tsx
// field.tsx
export function Label(props: React.LabelHTMLAttributes<HTMLLabelElement> & { htmlFor?: string }): React.JSX.Element;
type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };
export function Input(props: InputProps): React.JSX.Element;
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }): React.JSX.Element;
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }): React.JSX.Element;
export function Checkbox(props: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element;
```

- [ ] **Step 1: Create button.tsx**

```tsx
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
  secondary:
    "bg-surface-2 text-foreground hover:bg-muted border border-border",
  ghost:
    "text-muted-foreground hover:text-foreground hover:bg-muted",
  danger:
    "bg-danger text-white hover:bg-danger/90 shadow-sm",
  outline:
    "border border-border text-foreground hover:bg-muted",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  icon: "h-8 w-8",
};

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={[
        "inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(" ")}
      {...rest}
    />
  );
}
```

- [ ] **Step 2: Create field.tsx**

```tsx
import type {
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

const base =
  "w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50";
const invalidBase = "border-danger focus:border-danger focus:ring-danger/40";

export function Label({
  className = "",
  ...rest
}: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={[
        "mb-1.5 block text-xs font-medium text-muted-foreground",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export function Input({ invalid, className = "", ...rest }: InputProps) {
  return (
    <input
      className={[
        base,
        invalid ? invalidBase : "",
        "h-9",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export function Textarea({
  invalid,
  className = "",
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return (
    <textarea
      className={[base, invalid ? invalidBase : "", "py-2", className].join(" ")}
      {...rest}
    />
  );
}

export function Select({
  invalid,
  className = "",
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean }) {
  return (
    <select
      className={[base, invalid ? invalidBase : "", "h-9", className].join(" ")}
      {...rest}
    />
  );
}

export function Checkbox({
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={[
        "h-4 w-4 rounded border-border bg-surface-2 accent-primary",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/components/ui/button.tsx app/components/ui/field.tsx
git commit -m "feat: add Button and field primitives"
```

---

### Task 4: Card and Badge

**Files:**
- Create: `app/components/ui/card.tsx`
- Create: `app/components/ui/badge.tsx`

**Interfaces:**
- Produces:

```tsx
export function Card(props: React.HTMLAttributes<HTMLDivElement> & { padded?: boolean }): React.JSX.Element;
export function CardHeader(props: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element;
export function CardTitle(props: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element;

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";
type BadgeStyle = "solid" | "subtle";
export function Badge(props: React.HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; style?: BadgeStyle }): React.JSX.Element;
```

- [ ] **Step 1: Create card.tsx**

```tsx
import type { HTMLAttributes } from "react";

export function Card({
  padded = true,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div
      className={[
        "rounded-xl border border-border bg-surface shadow-sm",
        padded ? "p-5" : "",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export function CardHeader({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={["mb-4 flex items-center justify-between gap-3", className].join(" ")} {...rest} />;
}

export function CardTitle({ className = "", ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={["text-sm font-semibold text-foreground", className].join(" ")} {...rest} />;
}
```

- [ ] **Step 2: Create badge.tsx**

```tsx
import type { HTMLAttributes } from "react";

export type BadgeTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";
export type BadgeStyle = "solid" | "subtle";

const SOLID: Record<BadgeTone, string> = {
  neutral: "bg-muted text-foreground",
  success: "bg-success text-white",
  warning: "bg-warning text-white",
  danger: "bg-danger text-white",
  info: "bg-info text-white",
  primary: "bg-primary text-primary-foreground",
};

const SUBTLE: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  success: "bg-success/15 text-success",
  warning: "bg-warning/15 text-warning",
  danger: "bg-danger/15 text-danger",
  info: "bg-info/15 text-info",
  primary: "bg-primary/15 text-primary",
};

export function Badge({
  tone = "neutral",
  style = "subtle",
  className = "",
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; style?: BadgeStyle }) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
        style === "solid" ? SOLID[tone] : SUBTLE[tone],
        className,
      ].join(" ")}
      {...rest}
    />
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/components/ui/card.tsx app/components/ui/badge.tsx
git commit -m "feat: add Card and Badge primitives"
```

---

### Task 5: Toggle and Tabs

**Files:**
- Create: `app/components/ui/toggle.tsx`
- Create: `app/components/ui/tabs.tsx`

**Interfaces:**
- Produces:

```tsx
export function Toggle(props: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean; label?: string }): React.JSX.Element;

export function Tabs(props: { tabs: string[]; active: string; onChange: (tab: string) => void; className?: string }): React.JSX.Element;
```

- [ ] **Step 1: Create toggle.tsx**

```tsx
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
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
        checked ? "bg-primary" : "bg-muted",
      ].join(" ")}
    >
      <span
        className={[
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5",
        ].join(" ")}
      />
    </button>
  );
}
```

- [ ] **Step 2: Create tabs.tsx**

```tsx
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
              "shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              selected
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground hover:bg-muted",
            ].join(" ")}
          >
            {tab}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/components/ui/toggle.tsx app/components/ui/tabs.tsx
git commit -m "feat: add accessible Toggle and Tabs primitives"
```

---

### Task 6: Combobox upgrade + Tooltip

**Files:**
- Create: `app/components/ui/combobox.tsx` (supersedes `app/components/combobox.tsx`)
- Create: `app/components/ui/tooltip.tsx`

**Interfaces:**
- Produces:

```tsx
type ComboboxProps = {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  name?: string;
  placeholder?: string;
  required?: boolean;
  className?: string;
};
export function Combobox(props: ComboboxProps): React.JSX.Element;

export function Tooltip(props: { label: string; children: React.ReactNode }): React.JSX.Element;
```

- [ ] **Step 1: Create combobox.tsx (accessible)**

Copy `app/components/combobox.tsx` logic into `app/components/ui/combobox.tsx` with these changes:
- `role="listbox"` on the `<ul>`, `role="option"` + `aria-selected` on each `<li>`.
- `aria-expanded={open}` + `aria-haspopup="listbox"` on the input.
- `aria-activedescendant` on the input pointing at `option-${i}`; add `id={`option-${i}`}` to options.
- Keep keyboard nav (Arrow/Enter/Escape), outside-click close, filtered options (slice 20).
- Option buttons keep `type="button"` and `onMouseDown={(e) => e.preventDefault()}`.

- [ ] **Step 2: Create tooltip.tsx**

```tsx
import type { ReactNode } from "react";

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <span className="group/tip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface-2 px-2 py-1 text-xs text-foreground opacity-0 shadow-md transition-opacity group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {label}
      </span>
    </span>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/components/ui/combobox.tsx app/components/ui/tooltip.tsx
git commit -m "feat: accessible Combobox and Tooltip"
```

---

### Task 7: ConfirmDialog + useConfirm hook

**Files:**
- Create: `app/components/ui/confirm-dialog.tsx`

**Interfaces:**
- Produces:

```tsx
type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
};
export function useConfirm(): {
  dialog: React.ReactElement;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
};
```

Usage pattern for destructive form submits:
```tsx
const { dialog, confirm } = useConfirm();
const onSubmit = async (e: React.FormEvent) => {
  e.preventDefault();
  const ok = await confirm({ title: "Delete key?", description: "This cannot be undone.", variant: "danger" });
  if (ok) (e.currentTarget as HTMLFormElement).submit();
};
```

- [ ] **Step 1: Create confirm-dialog.tsx**

```tsx
import { useRef, useState, useEffect, useCallback } from "react";
import { Button } from "./button";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
};

type Pending = { opts: ConfirmOptions; resolve: (v: boolean) => void };

export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending({ opts, resolve });
    });
  }, []);

  useEffect(() => {
    if (pending && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [pending]);

  const close = (result: boolean) => {
    dialogRef.current?.close();
    pending?.resolve(result);
    setPending(null);
  };

  const dialog = pending ? (
    <dialog
      ref={dialogRef}
      className="m-auto w-[min(92vw,420px)] rounded-xl border border-border bg-surface p-5 text-foreground shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) close(false);
      }}
    >
      <h3 className="text-base font-semibold">{pending.opts.title}</h3>
      {pending.opts.description ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{pending.opts.description}</p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => close(false)}>
          {pending.opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          variant={pending.opts.variant === "danger" ? "danger" : "primary"}
          onClick={() => close(true)}
        >
          {pending.opts.confirmLabel ?? "Confirm"}
        </Button>
      </div>
    </dialog>
  ) : null;

  return { dialog, confirm };
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS. Note: `showModal` may require a type assertion if TS lib lacks it — verify `lib.dom` includes it (TS 5.9 does).

- [ ] **Step 3: Commit**

```bash
git add app/components/ui/confirm-dialog.tsx
git commit -m "feat: ConfirmDialog + useConfirm hook"
```

---

### Task 8: CopyButton and Toast system

**Files:**
- Create: `app/components/ui/copy-button.tsx`
- Create: `app/components/ui/toast.tsx`

**Interfaces:**
- Produces:

```tsx
export function CopyButton(props: { text: string; label?: string; className?: string }): React.JSX.Element;

type ToastInput = { title: string; description?: string; variant?: "success" | "error" | "info" };
export function ToastProvider(props: { children: React.ReactNode }): React.JSX.Element;
export function useToast(): { toast: (t: ToastInput) => void };
```

- [ ] **Step 1: Create copy-button.tsx**

```tsx
import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./button";

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      title={label}
      aria-label={label}
      className={className}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </Button>
  );
}
```

- [ ] **Step 2: Create toast.tsx**

```tsx
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";

type ToastInput = {
  title: string;
  description?: string;
  variant?: "success" | "error" | "info";
};

type ToastItem = ToastInput & { id: number };

const ToastContext = createContext<{ toast: (t: ToastInput) => void }>({
  toast: () => {},
});

const ICONS = {
  success: <CheckCircle2 size={16} className="text-success" />,
  error: <XCircle size={16} className="text-danger" />,
  info: <Info size={16} className="text-info" />,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((t: ToastInput) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { ...t, id }]);
    setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 4000);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface p-3 text-sm text-foreground shadow-lg animate-page-in"
          >
            <span className="mt-0.5 shrink-0">{ICONS[t.variant ?? "info"]}</span>
            <div className="min-w-0">
              <p className="font-medium">{t.title}</p>
              {t.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
```

- [ ] **Step 3: Wrap the app with ToastProvider**

In `app/root.tsx` `App` component, wrap the whole return (both the login branch and the layout branch) with `<ToastProvider>` inside the outer div; simplest is to wrap the component body:

```tsx
export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}
```
Move existing body into an `AppShell` component (keep sidebar state there). Import `ToastProvider` from `../components/ui/toast`.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/ui/copy-button.tsx app/components/ui/toast.tsx app/root.tsx
git commit -m "feat: CopyButton + toast notification system"
```

---

### Task 9: EmptyState, Spinner, Skeleton, UsageBar, StatCard, PageHeader, Table primitives

**Files:**
- Create: `app/components/ui/empty-state.tsx`
- Create: `app/components/ui/feedback.tsx` (Spinner, Skeleton)
- Create: `app/components/ui/usage-bar.tsx`
- Create: `app/components/ui/stat-card.tsx` (supersedes `app/components/stat-card.tsx`)
- Create: `app/components/ui/page-header.tsx`
- Create: `app/components/ui/table.tsx`

**Interfaces:**
- Produces:

```tsx
export function EmptyState(props: { icon?: React.ReactNode; title: string; description?: string; action?: React.ReactNode }): React.JSX.Element;
export function Spinner(props: { size?: number; className?: string }): React.JSX.Element;
export function Skeleton(props: { className?: string }): React.JSX.Element;
export function UsageBar(props: { value: number; max?: number; tone?: "success" | "warning" | "danger" }): React.JSX.Element;
export function StatCard(props: { title: string; value: string | number; suffix?: string; accent?: string; icon?: React.ReactNode }): React.JSX.Element;
export function PageHeader(props: { title: string; icon?: React.ReactNode; subtitle?: string; actions?: React.ReactNode }): React.JSX.Element;
export function Table(props: React.HTMLAttributes<HTMLTableElement>): React.JSX.Element;
export function THead(props: React.HTMLAttributes<HTMLTableSectionElement>): React.JSX.Element;
export function THeadCell(props: React.ThHTMLAttributes<HTMLTableCellElement>): React.JSX.Element;
export function TRow(props: React.HTMLAttributes<HTMLTableRowElement>): React.JSX.Element;
export function TCell(props: React.TdHTMLAttributes<HTMLTableCellElement>): React.JSX.Element;
```

- [ ] **Step 1: Create empty-state.tsx, feedback.tsx, usage-bar.tsx, stat-card.tsx, page-header.tsx, table.tsx**

```tsx
// empty-state.tsx
import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
```

```tsx
// feedback.tsx
import { Loader2 } from "lucide-react";

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-pulse rounded-md bg-muted ${className}`} aria-hidden="true" />
  );
}
```

```tsx
// usage-bar.tsx
const TONES = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export function UsageBar({
  value,
  max = 100,
  tone = "success",
}: {
  value: number;
  max?: number;
  tone?: "success" | "warning" | "danger";
}) {
  const pct = max <= 0 ? 0 : Math.min(100, Math.round((value / max) * 100));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={`h-full rounded-full ${TONES[tone]} transition-all`} style={{ width: `${pct}%` }} />
    </div>
  );
}
```

```tsx
// stat-card.tsx
import type { ReactNode } from "react";

export function StatCard({
  title,
  value,
  suffix,
  accent = "bg-primary",
  icon,
}: {
  title: string;
  value: string | number;
  suffix?: string;
  accent?: string;
  icon?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 shadow-sm">
      <div className="mb-3 flex items-center justify-between">
        <div className={`h-1 w-10 rounded-full ${accent}`} />
        {icon ? <span className="text-muted-foreground">{icon}</span> : null}
      </div>
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">
        {value}
        {suffix ? <span className="ml-1 text-sm font-medium text-muted-foreground">{suffix}</span> : null}
      </p>
    </div>
  );
}
```

```tsx
// page-header.tsx
import type { ReactNode } from "react";

export function PageHeader({
  title,
  icon,
  subtitle,
  actions,
}: {
  title: string;
  icon?: ReactNode;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2.5">
        {icon ? <span className="text-foreground">{icon}</span> : null}
        <div>
          <h1 className="text-xl font-bold text-foreground">{title}</h1>
          {subtitle ? <p className="mt-0.5 text-sm text-muted-foreground">{subtitle}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
```

```tsx
// table.tsx
import type {
  HTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
  HTMLTableSectionElement,
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
      className={["border-b border-border text-xs uppercase tracking-wide text-muted-foreground", className].join(" ")}
      {...rest}
    />
  );
}

export function THeadCell({ className = "", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return <th scope="col" className={["py-2 pr-4 font-medium", className].join(" ")} {...rest} />;
}

export function TRow({ className = "", ...rest }: HTMLAttributes<HTMLTableRowElement>) {
  return <tr className={["border-b border-border transition-colors hover:bg-muted/40", className].join(" ")} {...rest} />;
}

export function TCell({ className = "", ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={["py-2.5 pr-4", className].join(" ")} {...rest} />;
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/components/ui/
git commit -m "feat: EmptyState, feedback, UsageBar, StatCard, PageHeader, Table primitives"
```

---

## Phase 3 — Layout refactor

### Task 10: Sidebar and Header refactor

**Files:**
- Modify: `app/components/sidebar.tsx`
- Modify: `app/components/header.tsx`
- Modify: `app/root.tsx` (page fade on `<main>`)

**Interfaces:**
- Consumes: `Button`, `Toggle` not needed here; uses tokens directly. Uses `Tooltip` for theme button.

- [ ] **Step 1: Refactor Sidebar**

Rewrite `sidebar.tsx`:
- Use `bg-surface-2` for the sidebar container (darker than content), `border-border` borders.
- Brand block: keep "UniRoute" / "AI Gateway Admin"; swap `text-gray-*`/`dark:*` classes for tokens (`text-foreground`, `text-muted-foreground`).
- `linkClass`: active = `bg-primary/15 text-primary` + a `::before`-style left accent using a span: `relative` link with `before:absolute before:left-0 before:top-1/2 before:-translate-y-1/2 before:h-4 before:w-0.5 before:rounded-full before:bg-primary` shown only when active. Simpler: active classes `bg-primary/15 text-primary` plus a 3px left accent via `border-l-2 border-l-primary` on the link.
- Section labels: `text-xs font-semibold uppercase tracking-wide text-muted-foreground`.
- Keep NAV_ITEMS / MONITORING_ITEMS / ANALYTICS_ITEMS arrays and mobile overlay logic; mobile drawer uses `bg-surface`, `border-border`.
- Logout button: use `Button variant="ghost"` full-width via className `w-full justify-center`, or keep styled button with tokens. Use `<Button type="submit" variant="ghost" className="w-full justify-center">`.

- [ ] **Step 2: Refactor Header**

Rewrite `header.tsx`:
- Sticky: `sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur`.
- Replace `border-gray-200`/`dark:*` on the menu and theme buttons with `border-border text-muted-foreground hover:bg-muted hover:text-foreground`.
- Wrap the theme toggle in `Tooltip` with `label={theme === "dark" ? "Light mode" : "Dark mode"}`.
- Remove the `md:hidden` menu button's border-only style; keep it consistent.

- [ ] **Step 3: Page fade on main**

In `app/root.tsx`, add `key={pathname}` + `className="animate-page-in"` to the `<main>` element inside `AppShell`.

- [ ] **Step 4: Typecheck + smoke**

Run: `bun run typecheck`
Expected: PASS. Manually verify (if dev server available) dark default, toggle works, mobile drawer opens/closes.

- [ ] **Step 5: Commit**

```bash
git add app/components/sidebar.tsx app/components/header.tsx app/root.tsx
git commit -m "refactor: token-based sidebar/header + page fade"
```

---

## Phase 4 — Bug fixes

### Task 11: Fix stuck streaming on Stop (use-streaming)

**Files:**
- Modify: `app/hooks/use-streaming.ts:102-106`

- [ ] **Step 1: Fix AbortError handling**

Replace:
```ts
} catch (err) {
  if (err instanceof DOMException && err.name === "AbortError") return;
  setError(err instanceof Error ? err.message : String(err));
  setStreaming(false);
}
```
with:
```ts
} catch (err) {
  if (err instanceof DOMException && err.name === "AbortError") {
    setStreaming(false);
    setDone(true);
    return;
  }
  setError(err instanceof Error ? err.message : String(err));
  setStreaming(false);
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/hooks/use-streaming.ts
git commit -m "fix: stop streaming aborts cleanly instead of leaving UI stuck"
```

---

### Task 12: Realtime logs disconnect handling

**Files:**
- Modify: `app/hooks/use-realtime-logs.ts`

**Interfaces:**
- Produces: new return field `connected: boolean` (false while EventSource is disconnected/reconnecting).

- [ ] **Step 1: Add connection state + reconnect**

Add `const [connected, setConnected] = useState(true);`. In the `useEffect`:
- `es.onopen = () => setConnected(true);`
- `es.onerror = () => { setConnected(false); };` (browser auto-reconnects EventSource; state flips back to true on next `onopen`).
- Add `connected` to the returned object.

- [ ] **Step 2: Update consumers to show a banner**

In `app/routes/logs._index.tsx` and `app/routes/logs.proxy.tsx`, render a small amber banner when `!connected`:
```tsx
{!connected ? (
  <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
    Connection to live logs lost — reconnecting…
  </div>
) : null}
```
These files are refactored later (Task 18); add the banner now against the existing destructure `const { logs, paused, ... connected }`.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/hooks/use-realtime-logs.ts app/routes/logs._index.tsx app/routes/logs.proxy.tsx
git commit -m "fix: detect realtime log disconnects and surface reconnect banner"
```

---

### Task 13: API Manager — deleted-key screen, expires_at date, double submit

**Files:**
- Modify: `app/routes/api-manager.$id.tsx`
- Modify: `app/routes/api-manager.create.tsx`

- [ ] **Step 1: Fix deleted-key flow**

In `app/routes/api-manager.$id.tsx`, the action returns `{ deleted: true }` but the loader throws 404 on revalidation, so the "deleted" screen never renders. Fix:
- In the action, when deleting, `return redirect("/api-manager")` instead of returning `{ deleted: true }`, OR keep the return but make the loader NOT throw for the deleted id within the same request. Simplest robust fix: change the delete branch to `return redirect("/api-manager")`. Remove the now-unused `{ deleted: true }` screen (the `loaderData`/deleted UI) if present.

- [ ] **Step 2: Fix expires_at date shift**

In `app/routes/api-manager.$id.tsx` (~line 512), the date input value uses UTC. Replace:
```ts
new Date(ts * 1000).toISOString().slice(0, 10)
```
with a local-time formatter:
```ts
const d = new Date(ts * 1000);
const local = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
```
(define a small helper `toDateInput(d: Date): string` and reuse it).

- [ ] **Step 3: Fix api-manager.create double submit**

In `app/routes/api-manager.create.tsx`:
- The "Simpan" button is both `type="submit"` and has `onClick={handleAdd}`; `handleAdd` calls `form.requestSubmit()`. Remove `onClick={handleAdd}` from the submit button and instead guard on submit:
- Change the save button to plain `type="submit"`.
- In the form's `onSubmit` handler, if `apiKey` is empty, call `e.preventDefault()`, call `useToast().toast({ title: "API key required", variant: "error" })`, and return.
- Also translate the button/heading text (Indonesian → English) as part of Task 19 if not done there.

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/api-manager.$id.tsx app/routes/api-manager.create.tsx
git commit -m "fix: api-manager deleted flow, expires_at timezone, double submit"
```

---

### Task 14: logs pendingDelete leak + providers confirm bug

**Files:**
- Modify: `app/routes/logs._index.tsx`, `app/routes/logs.proxy.tsx` (pendingDelete clear)
- Modify: `app/routes/providers.$id.tsx` (broken confirm)

- [ ] **Step 1: Fix pendingDelete leak**

In both log routes, where the delete fetcher completes:
```ts
if (fetcher.data?.ok) { setPendingDelete(null); }
else { setPendingDelete(null); /* surface error */ }
```
Concretely: clear `pendingDelete` in ALL outcomes and show an error toast when `fetcher.data?.ok !== true`:
```ts
useEffect(() => {
  if (fetcher.state === "idle" && fetcher.data) {
    setPendingDelete(null);
    if (fetcher.data.ok !== true) {
      toast({ title: "Delete failed", variant: "error" });
    }
  }
}, [fetcher.state, fetcher.data]);
```
(Add `const { toast } = useToast();`.)

- [ ] **Step 2: Fix providers.$id broken confirm**

In `app/routes/providers.$id.tsx` (~line 591), the delete-provider button:
```tsx
<button type="submit" onClick={() => confirm(...)}>
```
ignores the result. Replace with `useConfirm()`:
```tsx
const { dialog, confirm } = useConfirm();
const handleDelete = async (e: React.FormEvent<HTMLFormElement>) => {
  e.preventDefault();
  const ok = await confirm({
    title: "Delete provider?",
    description: "This permanently removes the provider and its models.",
    confirmLabel: "Delete",
    variant: "danger",
  });
  if (ok) e.currentTarget.submit();
};
```
Render `{dialog}` and wire the form `onSubmit={handleDelete}`.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/routes/logs._index.tsx app/routes/logs.proxy.tsx app/routes/providers.$id.tsx
git commit -m "fix: clear pending log deletes on failure; real provider delete confirm"
```

---

## Phase 5 — Route refactors (full kit adoption)

> These tasks are mechanical: replace copy-pasted class strings with kit components and tokens, translate Indonesian to English, add label associations + aria-labels. Each task ends with typecheck + commit. Use the component APIs from Phase 2 exactly.

### Task 15: home.tsx + login.tsx

**Files:**
- Modify: `app/routes/home.tsx`
- Modify: `app/routes/login.tsx`

- [ ] **Step 1: home.tsx**

Replace the h1 with `PageHeader` (`title="Dashboard"`, `icon={<HomeIcon size={20} />}`). StatCards: use `StatCard` from `ui/stat-card` (delete import of `components/stat-card`). Map accents: `bg-green-500`→`bg-success`, `bg-amber-500`→`bg-warning`, `bg-violet-500`→`bg-info`, default `bg-blue-600`→`bg-primary`.

- [ ] **Step 2: login.tsx**

Use `Button` for submit (`type="submit"`, full width), `Input`/`Label` with `htmlFor`/`id` + `autoComplete="username"` / `"current-password"`. Convert `dark:*` classes to tokens. Translate remaining Indonesian labels if any (audit listed `login.tsx:24,44`).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/routes/home.tsx app/routes/login.tsx app/components/stat-card.tsx
git commit -m "refactor: home + login onto design system"
```
(Delete `app/components/stat-card.tsx` if nothing else imports it — grep first.)

---

### Task 16: providers.tsx + providers.$id.tsx + provider components

**Files:**
- Modify: `app/routes/providers.tsx`
- Modify: `app/routes/providers.$id.tsx`
- Modify: `app/components/provider-form.tsx`
- Modify: `app/components/provider-templates.tsx`

- [ ] **Step 1: providers.tsx**

- Headings: use `PageHeader` (`title="Providers"`); replace "Tambah provider"/"Daftar provider" + Indonesian copy with English ("Add provider", "Provider list", "Pick a template below to prefill the configuration.").
- Template picker: `ProviderTemplateCard` refactor (Step 3); the section heading uses `CardTitle`-style.
- Provider cards: use `Card` (padded), `Badge` for `AuthBadge` (tone by auth type: none→neutral, bearer→info, apikey→primary), `Toggle` for the ON/OFF switch (replaces the label+checkbox hack; call `onChange` → `requestSubmit()` of the hidden toggle Form as today, keep `id={`toggle-${p.id}`}`).
- `ProviderStatusCard`: use `Spinner` for pending, `Button variant="outline" size="sm"` for Test. Status text classes → tokens (`text-success`, `text-danger`, `text-muted-foreground`).

- [ ] **Step 2: providers.$id.tsx**

- `PageHeader` for the provider title; `Tabs` for the existing tab switcher (`TabButton` → `Tabs` with `role`).
- `KeyTestButton` keep logic; use `Spinner`/`Button`.
- Delete buttons (key delete, provider delete) → `useConfirm()` (provider delete already wired in Task 14).
- All `dark:*` classes → tokens; Indonesian → English (audit: `:98,102,130,251,291,328,346,377,392,442,454,488,513,526,564,596`).

- [ ] **Step 3: provider-form.tsx + provider-templates.tsx**

- `ProviderForm`: `Card` wrapper, `Input`/`Select`/`Checkbox`/`Label` with `htmlFor`/`id`; `Button` primary for submit, outline for cancel; translate "ubah field di bawah bila perlu" → English.
- `ProviderTemplateCard`: `Card`-like styling, `Badge` for auth label, translate "Isi manual"/"Gunakan" → "Manual"/"Use".

- [ ] **Step 4: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/routes/providers.tsx app/routes/providers.$id.tsx app/components/provider-form.tsx app/components/provider-templates.tsx
git commit -m "refactor: providers pages onto design system (English, kit, confirm, toggle)"
```

---

### Task 17: api.tsx

**Files:**
- Modify: `app/routes/api.tsx`

- [ ] **Step 1: Refactor**

- `PageHeader` (`title="API"`).
- Remove/replace the stale Indonesian banner (`:126-127`) — either delete it or rewrite in English pointing to API Manager only if still accurate; audit says the page still manages public models/allowlist/rules, so delete the "moved" banner.
- Cards → `Card`; toggles → `Toggle`; badges → `Badge`; delete-as-text buttons → `Button variant="ghost"` or `danger` icon button; tables → `Table/THead/THeadCell/TRow/TCell`.
- Add `EmptyState` for the allowlist table (currently missing).
- `inputClass()` fn → `Input` component; `labelClass` → `Label`.
- Fix mis-indented `table-wrap` divs (`:167,205,216,279`).
- Translate Indonesian strings (`:126,127,144,273`).

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/routes/api.tsx
git commit -m "refactor: api page onto design system"
```

---

### Task 18: API Manager pages (5 files)

**Files:**
- Modify: `app/routes/api-manager._index.tsx`
- Modify: `app/routes/api-manager.$id.tsx`
- Modify: `app/routes/api-manager.create.tsx`
- Modify: `app/routes/api-manager.groups.tsx`
- Modify: `app/routes/api-manager.templates.tsx`

- [ ] **Step 1: Refactor each file**

Apply consistently across all five:
- `PageHeader` for h1s; remove dead code (`api-manager._index.tsx:57` unused `has`).
- `inputClass`/`editInput`/`editLabel` → `Input`/`Label`.
- Local `StatCard` (`_index.tsx:401-408`) → `ui/stat-card`.
- `CopyButton` local copies (`_index.tsx:410-446`, `create.tsx:133-143`, inline `$id.tsx:283-289`) → `ui/copy-button`.
- Status pill maps (`STATUS_STYLE`) → `Badge` tones (success/warning/danger/info/primary).
- Confirm-wrapped submits (row delete, revoke, etc.) → `useConfirm()` (already-good pattern kept, standardized).
- `UsageBar`/progress bars → `ui/usage-bar` (fix `$id.tsx:341` `rounded` vs `rounded-full` mismatch).
- `EditInput`/`EditLabel` and reveals: keep reveal logic, add `Tooltip` explaining when reveal is disabled by `ALLOW_API_KEY_REVEAL`.
- `DailyBar` chart (`$id.tsx:421`): add `aria-label` to `role="img"`.
- `expires_at` handling already fixed in Task 13.
- Tables → `Table` primitives; empty rows → `EmptyState`.
- Translate all remaining Indonesian strings (audit list in Task 13/18 context: `_index.tsx:169,197,260,390,463-468,506-508`; `$id.tsx:177,179,224,243,255,268,277,382,419,442`; `groups.tsx:175`; `templates.tsx:137`; `create.tsx:185,219,236,257,296,321,350,372`).
- Reset form after successful creation in `create.tsx` (clear key fields) to avoid duplicate-key on re-submit.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/routes/api-manager._index.tsx app/routes/api-manager.$id.tsx app/routes/api-manager.create.tsx app/routes/api-manager.groups.tsx app/routes/api-manager.templates.tsx
git commit -m "refactor: api-manager pages onto design system"
```

---

### Task 19: combo.tsx + compression.tsx

**Files:**
- Modify: `app/routes/combo.tsx`
- Modify: `app/routes/compression.tsx`

- [ ] **Step 1: combo.tsx**

- `PageHeader` (`title="Combo"`); translate the entire page to English (fully Indonesian per audit).
- Cards → `Card`; `inputClass` → `Input`; step cards → `Card padded={false}` + `p-3` inner or `Card` with `className="p-3"`; badges (blue chips, gray tags) → `Badge`.
- `ModelAdder`/`KeyAdder` multi-select chips: refactor onto `ui/combobox` + `Badge` chips; keep add/remove semantics.
- Delete-step confirm already correct (`:721-723`) → `useConfirm()`.
- Pipeline badge `bg-purple-100/purple-700` → `Badge tone="primary"` (or info) for consistency.
- `parseList`/`parseNum` helpers stay local (they're small) unless all moved; keep local to avoid cross-file churn, but they're fine.

- [ ] **Step 2: compression.tsx**

- `PageHeader`; cards → `Card`; inputs → `Input`; buttons → `Button`.
- Fix the test branch reading fields the test form never sends: the "Run test" form only posts `intent`+`sample`; make the action read `rtk_binary_path`/`caveman_binary_path` with fallback to the current defaults `./bin/rtk` and `./bin/caveman`, or add the two path fields to the test form with default values. Preferred: add hidden inputs carrying the current binary paths to the test form so the action's existing reads are correct:
```tsx
<input type="hidden" name="rtk_binary_path" value={rtkPath} />
<input type="hidden" name="caveman_binary_path" value={cavemanPath} />
```
- Translate Indonesian strings (`:98,110`).

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/routes/combo.tsx app/routes/compression.tsx
git commit -m "refactor: combo + compression onto design system (English)"
```

---

### Task 20: proxies pages (3 files)

**Files:**
- Modify: `app/routes/proxies.tsx`
- Modify: `app/routes/proxies.$id.tsx`
- Modify: `app/routes/proxies.create.tsx`

- [ ] **Step 1: Refactor each file**

- Standardize card scheme: proxies pages use `dark:bg-gray-800`/`dark:border-gray-700` — replaced by `Card` (single scheme).
- `PageHeader` for h1s (proxies currently `text-xl font-bold` without icon — now unified via PageHeader).
- Inputs (`bg-gray-50` family) → `Input`; labels (uppercase variant) → `Label`; buttons → `Button`.
- Tabs (`proxies.tsx:543-557`) → `ui/tabs` (add `type="button"`, roles).
- Status dots/toggles (`:609-613,636-642,1066-1069`) → `Toggle` + `Badge`.
- Sync button (`:726-731`): add `Spinner` while pending via `fetcher.state === "submitting"`.
- Fix silent drop of sync results: after loading staged results (`staging.length > 0`), re-running sync should replace staging rather than disappear — update state so a second sync replaces `staging`.
- Deletes/unassigns (`:644-654,1003-1014,1204-1218,1323-1345`) → `useConfirm()`.
- Icon-only buttons: add `aria-label`; `Tooltip` optional.
- Tables → `Table` primitives; empty states → `EmptyState`.
- These pages are already English — no translation needed.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/routes/proxies.tsx app/routes/proxies.$id.tsx app/routes/proxies.create.tsx
git commit -m "refactor: proxies pages onto design system"
```

---

### Task 21: logs pages + LogViewer consolidation

**Files:**
- Modify: `app/routes/logs._index.tsx`
- Modify: `app/routes/logs.proxy.tsx`
- Modify: `app/components/log-viewer.tsx` (make it the single shared implementation; currently unused)

- [ ] **Step 1: Consolidate the two near-identical log views**

Both `logs._index.tsx` and `logs.proxy.tsx` duplicate `Row`, `Detail`, `fmtTs`, `printable`, pause/header chrome. Refactor:
- `log-viewer.tsx` becomes the shared component: `LogViewer({ logs, paused, onTogglePause, onDelete, onClear, connected, type })` rendering header (pause/clear/delete buttons), the disconnect banner, and the scrollable list (use `h-[calc(100vh-330px)] sm:h-[calc(100vh-290px)]` — pick ONE height, use it in both routes and remove the `280px`/`220px` variant).
- Both routes call `<LogViewer .../>` with their fetchers for delete/clear. Keep the disconnect banner from Task 12 inside LogViewer.
- Delete/clear actions → `useConfirm()` (add the missing confirm for Clear-all and row delete).
- `statusClass`/`LEVEL_COLORS` maps → `Badge` tones; keep `tabs-scroll` behavior for the log-type header if present.
- These pages are English already.

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add app/routes/logs._index.tsx app/routes/logs.proxy.tsx app/components/log-viewer.tsx
git commit -m "refactor: shared LogViewer + confirms + badge tones"
```

---

### Task 22: analytics.usage.tsx + usage-chart + model-selector + streaming-response + message-input

**Files:**
- Modify: `app/routes/analytics.usage.tsx`
- Modify: `app/components/usage-chart.tsx`
- Modify: `app/components/model-selector.tsx`
- Modify: `app/components/streaming-response.tsx`
- Modify: `app/components/message-input.tsx`

- [ ] **Step 1: analytics.usage.tsx + usage-chart.tsx**

- `PageHeader` for the heading.
- `usage-chart.tsx`: `Card` wrapper; keep SVG but use tokens via `className="text-primary"` / `text-muted-foreground` for hard-coded `#3b82f6`/`#4b5563` fills (use `currentColor` with those classes on the bar/axis elements); keep `role="img"` and add `aria-label="Usage over last 7 days"`.

- [ ] **Step 2: streaming-response.tsx + message-input.tsx**

- Translate Indonesian strings (`streaming-response.tsx:22,26`; `usage-chart.tsx:14`).
- `message-input.tsx`: use `Textarea` (keep `focus:border-blue-500` behavior via `Input`/`Textarea` built-in focus) and `Button` for send; preserve controlled behavior.
- `model-selector.tsx`: either wire it into the playground (`providers.$id.tsx`) as the model picker replacing the raw `<select>`, or if it doesn't fit cleanly, leave it unused — do NOT delete without a grep confirming no imports.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/routes/analytics.usage.tsx app/components/usage-chart.tsx app/components/streaming-response.tsx app/components/message-input.tsx
git commit -m "refactor: analytics + chat components onto design system"
```

---

### Task 23: Final English sweep + dead-code cleanup

**Files:**
- Grep-driven: all `app/routes/*.tsx`, `app/components/*.tsx`, `app/hooks/*.tsx`

- [ ] **Step 1: Sweep remaining Indonesian**

Run: `rg -n "Tambah|Daftar|Hapus|Simpan|Kelola|ubah|Pilih|Gunakan|Isi|berikut|silakan|di bawah|tidak ada" app/routes app/components`
Fix every remaining hit to English. Ensure `<html lang="en">` (already set in `root.tsx`).

- [ ] **Step 2: Dead code**

- Remove `app/components/combobox.tsx` (superseded by `ui/combobox.tsx`) after grep confirms no imports.
- Remove `app/components/stat-card.tsx` if unused after Task 15 (grep).
- Remove `app/components/.gitkeep` if it's just a placeholder.
- Grep for `dark:` remaining anywhere in `app/` and convert to tokens/`light:` variant if still needed.

- [ ] **Step 3: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A app
git commit -m "refactor: final English sweep + dead component cleanup"
```

---

## Phase 6 — Verification

### Task 24: Full verification

**Files:**
- None (verification only)

- [ ] **Step 1: Typecheck**

Run: `bun run typecheck`
Expected: PASS with zero errors.

- [ ] **Step 2: Tests**

Run: `bun test`
Expected: PASS (server + route tests unaffected by UI refactor).

- [ ] **Step 3: Build**

Run: `bun run build`
Expected: PASS.

- [ ] **Step 4: Manual smoke test**

If a dev/prod server is available, verify:
1. Default theme is dark; toggle works; reload persists.
2. Dashboard renders stat cards + chart.
3. Providers: toggle ON/OFF, Test button, create-from-template, delete with confirm.
4. API Manager: create key (empty key shows error toast), reveal key, delete key redirects to list, group/template CRUD with confirms.
5. Combo: add/remove steps with confirm; Compression test runs with binary paths.
6. Proxies: sync shows spinner, staging load replaces on re-sync, deletes confirm.
7. Logs: live streaming, pause, delete row, clear all (confirm), disconnect banner shows when server stops.
8. Playground streaming in providers.$id: Send streams, Stop leaves UI ready for the next send.
9. Mobile width: drawer sidebar opens/closes, tables scroll.

- [ ] **Step 5: Fix any issues found and re-run Steps 1-3**

If smoke test surfaces regressions, fix and re-verify.

- [ ] **Step 6: Commit any remaining fixes**

```bash
git add -A
git commit -m "chore: verification fixes"
```

---

## Self-Review Notes

- **Spec coverage:** tokens (T1), dark-first default (T2), kit components (T3-T9), layout (T10), all 10 audited bugs (T11-T14 + route tasks), English sweep (T15-T23), verification (T24). No spec section lacks a task.
- **Bug mapping:** broken confirm→T14/T16/T18/T20; stuck stream→T11; deleted-key screen→T13; double submit→T13; expires_at→T13; pendingDelete→T14; EventSource onerror→T12; proxies sync drop→T20; api.tsx banner→T17; a11y→throughout.
- **Component names:** `Button`, `Input`, `Textarea`, `Select`, `Checkbox`, `Label`, `Card`, `CardHeader`, `CardTitle`, `Badge`, `Toggle`, `Tabs`, `Combobox`, `Tooltip`, `useConfirm` (+`dialog`), `CopyButton`, `ToastProvider`, `useToast`, `EmptyState`, `Spinner`, `Skeleton`, `UsageBar`, `StatCard`, `PageHeader`, `Table`, `THead`, `THeadCell`, `TRow`, `TCell` — consistent across all tasks.
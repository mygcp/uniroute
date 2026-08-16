# API Manager UX Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/api-manager` create/edit key forms consistent: glass-style header buttons, chip/tag autocomplete for Allowed/Blocked Models that separates models from combos, and explanatory placeholders on quota/budget/security fields.

**Architecture:** Three small layers — (1) a `buttonClass()` helper exported from `ui/button.tsx` reused by raw `<Link>` header actions; (2) a server module `suggest.ts` gains `getStructuredSuggestions()` returning `{value, type, provider?}` entries for models + `combo:<name>` entries; (3) a new client `TagInput` component (pure parsing logic lives in `tag-utils.ts` for unit testing) replaces the Allowed/Blocked Models textareas on both forms. No backend/enforcement changes.

**Tech Stack:** React 19, React Router 8 (`.server` convention), Tailwind 4, lucide-react, bun test.

## Global Constraints

- TypeScript strict; `npm run typecheck` and `npm run build` must pass at every commit.
- Tests run via `bun test`; the script globs `*.test.ts` in `app/.server` and `app/routes` (maxdepth 1) — component files are verified by typecheck/build, not runtime DOM tests.
- UI copy in English; follow existing glass styling in `app/components/ui/*`.
- No changes to key create/update actions or rate-limit enforcement.
- Do not touch `model_override` / `pinned_provider_id` fields.

---

### Task 1: Export `buttonClass` and restyle the `/api-manager` header actions

**Files:**
- Modify: `app/components/ui/button.tsx`
- Modify: `app/routes/api-manager._index.tsx` (PageHeader `actions`, lines ~210-230)
- Test: none (verify via typecheck + build)

**Interfaces:**
- Produces: `export function buttonClass(variant: "primary" | "secondary" | "ghost" | "danger" | "outline", size?: "sm" | "md" | "icon", extra?: string): string` — returns the exact class string `<Button>` uses today, so a `<Link>`/`<a>` looks identical to a `<Button>`.

- [ ] **Step 1: Refactor `button.tsx` to export the class builder**

```tsx
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
type Size = "sm" | "md" | "icon";

const VARIANTS: Record<Variant, string> = {
  primary:
    "border border-primary/25 bg-primary/15 text-primary hover:bg-primary/25",
  secondary:
    "border border-glass-border bg-glass-strong text-foreground hover:bg-glass-hover",
  ghost:
    "text-muted-foreground hover:bg-glass-hover hover:text-foreground",
  danger:
    "border border-danger/25 bg-danger/15 text-danger hover:bg-danger/25",
  outline:
    "border border-glass-border bg-glass text-foreground hover:bg-glass-hover",
};

const SIZES: Record<Size, string> = {
  sm: "h-8 px-3 text-xs",
  md: "h-9 px-4 text-sm",
  icon: "h-8 w-8",
};

export type ButtonVariant = Variant;
export type ButtonSize = Size;

export function buttonClass(
  variant: Variant = "primary",
  size: Size = "md",
  extra = "",
): string {
  return [
    "inline-flex items-center justify-center gap-2 rounded-lg font-medium shadow-[inset_0_1px_0_var(--glass-highlight)] transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50",
    VARIANTS[variant],
    SIZES[size],
    extra,
  ]
    .join(" ")
    .trim();
}

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
  return <button type={type} className={buttonClass(variant, size, className)} {...rest} />;
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Replace the three raw `<a>` header actions with `Link` + `buttonClass`**

In `app/routes/api-manager._index.tsx`:
- Change the react-router import from `import { Form } from "react-router";` to `import { Form, Link } from "react-router";`.
- Add `import { Button, buttonClass } from "../components/ui/button";` (keep `Button`, it's still used).
- Replace the three `<a>` tags inside `PageHeader` `actions`:

```tsx
actions={
  <>
    <Link to="/api-manager/templates" className={buttonClass("outline", "sm")}>
      Templates
    </Link>
    <Link to="/api-manager/groups" className={buttonClass("outline", "sm")}>
      Groups
    </Link>
    <Link to="/api-manager/create" className={buttonClass("primary", "sm")}>
      <Plus size={16} /> Create New Key
    </Link>
  </>
}
```

- [ ] **Step 4: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/components/ui/button.tsx app/routes/api-manager._index.tsx
git commit -m "feat: glass header buttons via buttonClass helper on /api-manager"
```

---

### Task 2: Structured suggestions (models + combos) in `suggest.ts`

**Files:**
- Modify: `app/.server/suggest.ts`
- Modify: `app/.server/suggest.test.ts`
- Test: `app/.server/suggest.test.ts`

**Interfaces:**
- Consumes: `listCombos()` from `app/.server/combo.ts` (returns `Combo[]`, each with `name: string`).
- Produces:
  ```ts
  export type TagSuggestion =
    | { value: string; type: "model"; provider?: string }
    | { value: string; type: "combo" };
  export function getStructuredSuggestions(): TagSuggestion[];
  ```

- [ ] **Step 1: Write the failing test**

Append to `app/.server/suggest.test.ts` (add a combo row in `beforeAll`):

```ts
  db.query(
    "INSERT INTO combos (name, strategy, config, created_at, updated_at) VALUES ('coding', 'priority', '{}', 0, 0)",
  ).run();
```

Add a new describe block:

```ts
describe("getStructuredSuggestions", () => {
  test("active models carry their provider", () => {
    const result = suggest.getStructuredSuggestions();
    const gpt4o = result.find((s) => s.value === "gpt-4o");
    expect(gpt4o).toEqual({ value: "gpt-4o", type: "model", provider: "p1" });
  });

  test("allowlist/key models are included without provider", () => {
    const result = suggest.getStructuredSuggestions();
    const legacy = result.find((s) => s.value === "legacy-model");
    expect(legacy).toEqual({ value: "legacy-model", type: "model" });
    const gpt4 = result.find((s) => s.value === "gpt-4");
    expect(gpt4).toEqual({ value: "gpt-4", type: "model" });
  });

  test("combos are listed as combo:<name> with type combo", () => {
    const result = suggest.getStructuredSuggestions();
    expect(result).toContainEqual({ value: "combo:coding", type: "combo" });
  });

  test("no duplicate values; models sorted before combos", () => {
    const result = suggest.getStructuredSuggestions();
    const values = result.map((s) => s.value);
    expect(new Set(values).size).toBe(values.length);
    const modelValues = result
      .filter((s) => s.type === "model")
      .map((s) => s.value);
    const comboValues = result
      .filter((s) => s.type === "combo")
      .map((s) => s.value);
    expect(modelValues).toEqual([...modelValues].sort((a, b) => a.localeCompare(b)));
    expect(comboValues).toEqual([...comboValues].sort((a, b) => a.localeCompare(b)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test app/.server/suggest.test.ts`
Expected: FAIL — `getStructuredSuggestions` is not a function.

- [ ] **Step 3: Implement `getStructuredSuggestions`**

Append to `app/.server/suggest.ts` (add `import { listCombos } from "./combo";` at the top):

```ts
export type TagSuggestion =
  | { value: string; type: "model"; provider?: string }
  | { value: string; type: "combo" };

/** Suggestions for the Allowed/Blocked Models tag input: models + combos. */
export function getStructuredSuggestions(): TagSuggestion[] {
  const modelRows = query(
    `SELECT m.model_name AS model, m.provider_id AS provider
     FROM models m WHERE m.is_active = 1`,
  ).all() as unknown as { model: string; provider: string }[];

  const extraRows = query(
    `SELECT model_name AS model FROM model_allowlist
     UNION
     SELECT source_model FROM routing_rules
     UNION
     SELECT target_model FROM routing_rules WHERE target_model IS NOT NULL AND target_model <> ''
     UNION
     SELECT model_override FROM client_api_keys WHERE model_override IS NOT NULL AND model_override <> ''`,
  ).all() as unknown as { model: string }[];

  const keyRows = query(
    "SELECT allowed_models FROM client_api_keys WHERE allowed_models IS NOT NULL",
  ).all() as unknown as { allowed_models: string }[];

  const byName = new Map<string, TagSuggestion>();
  for (const row of modelRows) {
    const name = row.model?.trim();
    if (!name) continue;
    const existing = byName.get(name);
    const provider = row.provider?.trim() || undefined;
    if (!existing || (existing.type === "model" && !existing.provider)) {
      byName.set(name, { value: name, type: "model", provider });
    }
  }
  const addExtra = (name: unknown): void => {
    const clean = typeof name === "string" ? name.trim() : "";
    if (!clean) return;
    if (!byName.has(clean)) byName.set(clean, { value: clean, type: "model" });
  };
  for (const row of extraRows) addExtra(row.model);
  for (const row of keyRows) {
    try {
      const parsed = JSON.parse(row.allowed_models);
      if (Array.isArray(parsed)) for (const m of parsed) addExtra(m);
    } catch {
      /* skip malformed JSON */
    }
  }

  const models = [...byName.values()].sort((a, b) => a.value.localeCompare(b.value));
  const combos = listCombos()
    .map((c): TagSuggestion => ({ value: `combo:${c.name}`, type: "combo" }))
    .sort((a, b) => a.value.localeCompare(b.value));
  return [...models, ...combos];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test app/.server/suggest.test.ts`
Expected: PASS (all existing + new tests).

- [ ] **Step 5: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add app/.server/suggest.ts app/.server/suggest.test.ts
git commit -m "feat: structured model+combo suggestions for key forms"
```

---

### Task 3: Pure tag-utils module

**Files:**
- Create: `app/.server/tag-utils.ts`
- Create: `app/.server/tag-utils.test.ts`
- Test: `app/.server/tag-utils.test.ts`

**Interfaces:**
- Consumes: `TagSuggestion` type (type-only import from `./suggest`).
- Produces:
  ```ts
  export function parseChips(value: string): string[]
  export function joinChips(chips: string[]): string
  export function addChip(chips: string[], text: string): { chips: string[]; clear: boolean }
  export function removeChip(chips: string[], index: number): string[]
  export function filterSuggestions(options: TagSuggestion[], chips: string[], query: string, limit?: number): TagSuggestion[]
  ```

- [ ] **Step 1: Write the failing test**

Create `app/.server/tag-utils.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { TagSuggestion } from "./suggest";
import {
  addChip,
  filterSuggestions,
  joinChips,
  parseChips,
  removeChip,
} from "./tag-utils";

const OPTIONS: TagSuggestion[] = [
  { value: "gpt-4o", type: "model", provider: "openai" },
  { value: "claude-3.5", type: "model", provider: "anthropic" },
  { value: "combo:coding", type: "combo" },
];

describe("parseChips / joinChips", () => {
  test("splits on commas and newlines, trims, drops empties", () => {
    expect(parseChips(" gpt-4o ,\nclaude-3.5\n, ,")).toEqual(["gpt-4o", "claude-3.5"]);
  });
  test("joinChips re-joins with comma+space", () => {
    expect(joinChips(["gpt-4o", "combo:coding"])).toBe("gpt-4o, combo:coding");
  });
});

describe("addChip", () => {
  test("appends trimmed text and clears the input", () => {
    expect(addChip(["gpt-4o"], "  claude-3.5  ")).toEqual({
      chips: ["gpt-4o", "claude-3.5"],
      clear: true,
    });
  });
  test("does not duplicate existing chips but still clears", () => {
    expect(addChip(["gpt-4o"], "gpt-4o")).toEqual({ chips: ["gpt-4o"], clear: true });
  });
  test("empty text is ignored and input is kept", () => {
    expect(addChip(["gpt-4o"], "  ")).toEqual({ chips: ["gpt-4o"], clear: false });
  });
});

describe("removeChip", () => {
  test("removes the chip at index", () => {
    expect(removeChip(["gpt-4o", "combo:coding"], 0)).toEqual(["combo:coding"]);
  });
});

describe("filterSuggestions", () => {
  test("filters by case-insensitive substring", () => {
    expect(filterSuggestions(OPTIONS, [], "gpt")).toEqual([{ value: "gpt-4o", type: "model", provider: "openai" }]);
  });
  test("hides chips that are already added", () => {
    expect(filterSuggestions(OPTIONS, ["gpt-4o"], "")).toEqual([
      { value: "claude-3.5", type: "model", provider: "anthropic" },
      { value: "combo:coding", type: "combo" },
    ]);
  });
  test("respects the limit", () => {
    expect(filterSuggestions(OPTIONS, [], "", 1)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test app/.server/tag-utils.test.ts`
Expected: FAIL — module not found / functions undefined.

- [ ] **Step 3: Implement `tag-utils.ts`**

```ts
import type { TagSuggestion } from "./suggest";

export function parseChips(value: string): string[] {
  return value
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function joinChips(chips: string[]): string {
  return chips.join(", ");
}

export function addChip(
  chips: string[],
  text: string,
): { chips: string[]; clear: boolean } {
  const clean = text.trim();
  if (!clean) return { chips, clear: false };
  const next = chips.includes(clean) ? chips : [...chips, clean];
  return { chips: next, clear: true };
}

export function removeChip(chips: string[], index: number): string[] {
  return chips.filter((_, i) => i !== index);
}

export function filterSuggestions(
  options: TagSuggestion[],
  chips: string[],
  query: string,
  limit = 20,
): TagSuggestion[] {
  const q = query.trim().toLowerCase();
  const existing = new Set(chips.map((c) => c.toLowerCase()));
  return options
    .filter((o) => !existing.has(o.value.toLowerCase()))
    .filter((o) => o.value.toLowerCase().includes(q))
    .slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test app/.server/tag-utils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/.server/tag-utils.ts app/.server/tag-utils.test.ts
git commit -m "feat: pure tag-utils for chip parsing and suggestion filtering"
```

---

### Task 4: `TagInput` component

**Files:**
- Create: `app/components/ui/tag-input.tsx`
- Test: none (typecheck/build verify)

**Interfaces:**
- Consumes: `TagSuggestion` type from `../../.server/suggest`; `parseChips`, `joinChips`, `addChip`, `removeChip`, `filterSuggestions` from `../../.server/tag-utils`.
- Produces:
  ```tsx
  export function TagInput(props: {
    options: TagSuggestion[];
    value: string;          // comma-separated chips
    onChange: (v: string) => void;
    id?: string;
    name?: string;          // hidden input name for form submit
    placeholder?: string;
    className?: string;
  }): ReactNode
  ```
  Renders a hidden `<input name={name}>` when `name` is set; the visible input never carries the name.

- [ ] **Step 1: Write the component**

Create `app/components/ui/tag-input.tsx`:

```tsx
import { useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { TagSuggestion } from "../../.server/suggest";
import {
  addChip,
  filterSuggestions,
  joinChips,
  parseChips,
  removeChip,
} from "../../.server/tag-utils";

type TagInputProps = {
  options: TagSuggestion[];
  value: string;
  onChange: (v: string) => void;
  id?: string;
  name?: string;
  placeholder?: string;
  className?: string;
};

export function TagInput({
  options,
  value,
  onChange,
  id,
  name,
  placeholder,
  className = "",
}: TagInputProps) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [closing, setClosing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(open);
  openRef.current = open;
  const closeTimerRef = useRef<number | null>(null);

  const chips = useMemo(() => parseChips(value), [value]);
  const filtered = useMemo(
    () => filterSuggestions(options, chips, text),
    [options, chips, text],
  );

  const closeDropdown = () => {
    if (!openRef.current) return;
    setClosing(true);
    if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
      setClosing(false);
    }, 100);
  };

  const openDropdown = () => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosing(false);
    setOpen(true);
  };

  const commit = (raw: string) => {
    const { chips: next, clear } = addChip(chips, raw);
    if (clear) {
      onChange(joinChips(next));
      setText("");
      setHighlight(0);
      openDropdown();
    }
  };

  const remove = (index: number) => {
    onChange(joinChips(removeChip(chips, index)));
  };

  return (
    <div
      ref={rootRef}
      className={`w-full rounded-lg border border-glass-border bg-glass-strong px-2 py-1.5 text-sm text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)] transition-colors focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20 ${className}`}
      onMouseDown={(e) => {
        if (e.target === rootRef.current) {
          const input = rootRef.current.querySelector("input");
          input?.focus();
        }
      }}
    >
      {name ? <input type="hidden" name={name} value={value} /> : null}
      <div className="flex flex-wrap items-center gap-1.5">
        {chips.map((chip, i) => (
          <span
            key={`${chip}-${i}`}
            className="inline-flex items-center gap-1 rounded-md border border-glass-border bg-glass px-2 py-0.5 text-xs font-medium text-foreground"
          >
            <span className="max-w-48 truncate">{chip}</span>
            <button
              type="button"
              aria-label={`Remove ${chip}`}
              className="text-muted-foreground hover:text-foreground"
              onClick={() => remove(i)}
            >
              <X size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          placeholder={placeholder}
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-autocomplete="list"
          aria-activedescendant={
            open && filtered.length > 0 ? `tag-option-${highlight}` : undefined
          }
          onFocus={openDropdown}
          onChange={(e) => {
            setText(e.target.value);
            openDropdown();
            setHighlight(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              if (open && filtered[highlight]) {
                commit(filtered[highlight].value);
              } else {
                commit(text);
              }
            } else if (e.key === "Backspace" && text === "" && chips.length > 0) {
              remove(chips.length - 1);
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
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
            } else if (e.key === "Escape") {
              closeDropdown();
            }
          }}
          className="min-w-24 flex-1 bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
        />
      </div>
      {open && filtered.length > 0 ? (
        <ul
          role="listbox"
          className={`absolute z-20 mt-1 max-h-48 w-full origin-top overflow-auto rounded-lg border border-glass-border bg-background/80 py-1 text-sm shadow-[0_8px_24px_rgba(0,0,0,0.35),inset_0_1px_0_var(--glass-highlight)] backdrop-blur-md transition-[transform,opacity] duration-100 ${
            closing
              ? "pointer-events-none scale-y-90 opacity-0"
              : "scale-y-100 opacity-100"
          }`}
        >
          {filtered.map((opt, i) => (
            <li
              key={opt.value}
              id={`tag-option-${i}`}
              role="option"
              aria-selected={i === highlight}
            >
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(opt.value)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-glass-hover ${
                  i === highlight ? "bg-glass-hover" : ""
                }`}
              >
                <span className="flex-1 truncate font-mono text-xs">
                  {opt.value}
                </span>
                {opt.type === "combo" ? (
                  <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-primary">
                    combo
                  </span>
                ) : (
                  <>
                    {opt.provider ? (
                      <span className="text-xs text-muted-foreground">
                        {opt.provider}
                      </span>
                    ) : null}
                    <span className="rounded bg-glass-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                      model
                    </span>
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

Note: the outer container must be `relative` for the absolutely-positioned dropdown to align. Wrap each usage site with a `relative` parent if the dropdown appears misaligned (see Task 5/6 — the TagInput root gets `relative` added via its own class when needed; simplest is to give the root `relative` unconditionally).

- [ ] **Step 2: Make the dropdown anchor correctly**

Edit the root `<div>` opening tag to include `relative`:

```tsx
      className={`relative w-full rounded-lg border border-glass-border bg-glass-strong px-2 py-1.5 ...`}
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/components/ui/tag-input.tsx
git commit -m "feat: TagInput chip component with model/combo suggestions"
```

---

### Task 5: Create form integration + placeholders

**Files:**
- Modify: `app/routes/api-manager.create.tsx`

**Interfaces:**
- Consumes: `getStructuredSuggestions` from `../.server/suggest`; `TagInput` from `../components/ui/tag-input`.
- Produces: `loader()` returns `{ structuredSuggestions, modelSuggestions, providerSuggestions, templates }`.

- [ ] **Step 1: Add suggestions to the loader**

In `api-manager.create.tsx`:
- Add `import { getModelSuggestions, getProviderSuggestions, getStructuredSuggestions } from "../.server/suggest";` and `import { TagInput } from "../components/ui/tag-input";`.
- In `loader()`:

```ts
export function loader() {
  return {
    modelSuggestions: getModelSuggestions(),
    providerSuggestions: getProviderSuggestions(),
    structuredSuggestions: getStructuredSuggestions(),
    templates: listTemplates().map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      config: t.config,
    })),
  };
}
```

- [ ] **Step 2: Add state for the two model fields**

In `CreateKey`, destructure `structuredSuggestions` from `loaderData` and add state:

```tsx
const { modelSuggestions, providerSuggestions, structuredSuggestions, templates } = loaderData;
const [allowedModels, setAllowedModels] = useState("");
const [blockedModels, setBlockedModels] = useState("");
```

Update the reset effect to also clear chip state:

```tsx
useEffect(() => {
  if (created?.newlyCreatedKey) {
    formRef.current?.reset();
    setAllowedModels("");
    setBlockedModels("");
  }
}, [created?.newlyCreatedKey]);
```

- [ ] **Step 3: Update `applyTemplate` to set chip state**

Inside `applyTemplate`, replace the two DOM `set` calls for the model fields with
state setters (the old lines are `set("allowed_models", template.allowedModels?.join(", ") ?? "")` and `set("blocked_models", template.blockedModels?.join(", ") ?? "")`):

```tsx
setAllowedModels(template.allowedModels?.join(", ") ?? "");
setBlockedModels(template.blockedModels?.join(", ") ?? "");
```

Keep the existing `set("allowed_providers", ...)` / `set("blocked_providers", ...)` lines — they remain regular text inputs.

- [ ] **Step 4: Swap the Model Access textareas for TagInput**

Replace the Allowed Models and Blocked Models `<div>`s (inside the "Model Access" `Section`):

```tsx
<div>
  <Label htmlFor="allowed_models">
    Allowed Models (empty = all)
  </Label>
  <TagInput
    id="allowed_models"
    name="allowed_models"
    options={structuredSuggestions}
    value={allowedModels}
    onChange={setAllowedModels}
    placeholder="gpt-4o, claude-3.5, gemini-1.5-pro"
  />
</div>
<div>
  <Label htmlFor="blocked_models">Blocked Models</Label>
  <TagInput
    id="blocked_models"
    name="blocked_models"
    options={structuredSuggestions}
    value={blockedModels}
    onChange={setBlockedModels}
    placeholder="gpt-4o-mini, llama-3-8b"
  />
</div>
```

- [ ] **Step 5: Add placeholders to the Budget & Quota inputs**

In the "Budget & Quota" `Section`, the mapped fields array becomes objects so each input gets a `placeholder`:

```tsx
<Section title="Budget & Quota">
  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
    {[
      ["budget_monthly", "Monthly Budget (USD)", "USD cap per month, e.g. 100"],
      ["budget_daily", "Daily Budget (USD)", "USD cap per day, e.g. 10"],
      ["budget_per_request", "Per-request (USD)", "Max USD per request, e.g. 0.002"],
      ["quota_tokens", "Tokens/Month", "Token cap per month, e.g. 100000"],
      ["quota_req_day", "Requests/Day", "Daily request cap, e.g. 1000"],
      ["quota_concurrent", "Concurrent", "Max active sessions, e.g. 5"],
      ["quota_rpm", "Requests/Min", "Rate limit per minute, e.g. 60"],
      ["quota_tpm", "Tokens/Min", "Token rate per minute, e.g. 100000"],
      ["alert_threshold", "Alert at (0..1)", "Fraction of budget before warning, e.g. 0.8"],
    ].map(([name, label, placeholder]) => (
      <div key={name as string}>
        <Label htmlFor={name as string}>{label}</Label>
        <Input
          id={name as string}
          name={name}
          type="number"
          step="any"
          placeholder={placeholder as string}
          autoComplete="off"
        />
      </div>
    ))}
  </div>
  ...
```

- [ ] **Step 6: Typecheck + build + tests**

Run: `npm run typecheck && npm run build && bun test app/.server/suggest.test.ts app/.server/tag-utils.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/routes/api-manager.create.tsx
git commit -m "feat: TagInput + placeholders on create key form"
```

---

### Task 6: Edit form integration + placeholders

**Files:**
- Modify: `app/routes/api-manager.$id.tsx`

**Interfaces:**
- Consumes: `getStructuredSuggestions` from `../.server/suggest`; `TagInput` from `../components/ui/tag-input`; `TagSuggestion` type.
- Produces: `loader()` returns `{ ..., structuredSuggestions }`; `EditKeyForm({ data, options }: { data: ClientKey; options: TagSuggestion[] })`.

- [ ] **Step 1: Add suggestions to the loader**

In `api-manager.$id.tsx`:
- Add `import { getStructuredSuggestions } from "../.server/suggest";`, `import { TagInput } from "../components/ui/tag-input";`, and `import type { TagSuggestion } from "../.server/suggest";`.
- In `loader()` return:

```ts
return {
  key,
  month,
  today,
  status,
  audit,
  byDay,
  groups,
  health,
  budget,
  structuredSuggestions: getStructuredSuggestions(),
};
```

- [ ] **Step 2: Thread options through to `EditKeyForm`**

In `KeyDetail`, destructure `structuredSuggestions` and render:

```tsx
{editing ? <EditKeyForm data={key} options={structuredSuggestions} /> : null}
```

Change the `EditKeyForm` signature and add chip state at the top:

```tsx
function EditKeyForm({ data, options }: { data: ClientKey; options: TagSuggestion[] }) {
  const [allowedModels, setAllowedModels] = useState(data.allowed_models?.join(", ") ?? "");
  const [blockedModels, setBlockedModels] = useState(data.blocked_models?.join(", ") ?? "");
```

(`useState` is already imported in this file.)

- [ ] **Step 3: Swap the model Textareas for TagInput**

In `EditKeyForm`:

```tsx
<div>
  <Label htmlFor="edit-allowed-models">Allowed Models (empty = all)</Label>
  <TagInput
    id="edit-allowed-models"
    name="allowed_models"
    options={options}
    value={allowedModels}
    onChange={setAllowedModels}
    placeholder="gpt-4o, claude-3.5, gemini-1.5-pro"
  />
</div>
<div>
  <Label htmlFor="edit-blocked-models">Blocked Models</Label>
  <TagInput
    id="edit-blocked-models"
    name="blocked_models"
    options={options}
    value={blockedModels}
    onChange={setBlockedModels}
    placeholder="gpt-4o-mini, llama-3-8b"
  />
</div>
```

- [ ] **Step 4: Add placeholders to Budget & Quota inputs**

In `EditKeyForm`, add `placeholder` to each quota/budget `Input`:

```tsx
<Input id="edit-budget-monthly" name="budget_monthly" type="number" step="any" placeholder="USD cap per month, e.g. 100" defaultValue={data.budget?.monthly ?? ""} autoComplete="off" />
<Input id="edit-budget-daily" name="budget_daily" type="number" step="any" placeholder="USD cap per day, e.g. 10" defaultValue={data.budget?.daily ?? ""} autoComplete="off" />
<Input id="edit-budget-per-request" name="budget_per_request" type="number" step="any" placeholder="Max USD per request, e.g. 0.002" defaultValue={data.budget?.per_request ?? ""} autoComplete="off" />
<Input id="edit-quota-tokens" name="quota_tokens" type="number" placeholder="Token cap per month, e.g. 100000" defaultValue={data.quota?.tokens_per_month ?? ""} autoComplete="off" />
<Input id="edit-quota-req-day" name="quota_req_day" type="number" placeholder="Daily request cap, e.g. 1000" defaultValue={data.quota?.requests_per_day ?? ""} autoComplete="off" />
<Input id="edit-quota-concurrent" name="quota_concurrent" type="number" placeholder="Max active sessions, e.g. 5" defaultValue={data.quota?.concurrent_requests ?? ""} autoComplete="off" />
<Input id="edit-quota-rpm" name="quota_rpm" type="number" placeholder="Rate limit per minute, e.g. 60" defaultValue={data.quota?.rpm ?? ""} autoComplete="off" />
<Input id="edit-quota-tpm" name="quota_tpm" type="number" placeholder="Token rate per minute, e.g. 100000" defaultValue={data.quota?.tpm ?? ""} autoComplete="off" />
<Input id="edit-alert-threshold" name="alert_threshold" type="number" step="any" min="0" max="1" placeholder="Fraction of budget before warning, e.g. 0.8" defaultValue={data.alert_threshold ?? ""} autoComplete="off" />
```

- [ ] **Step 5: Add placeholders/helpers to Security + Time fields in `EditKeyForm`**

```tsx
<Input id="edit-expires-at" name="expires_at" type="date" title="Leave empty = never expires" defaultValue={data.expires_at ? toDateInput(new Date(data.expires_at * 1000)) : ""} />
<Input id="edit-rotation-interval" name="rotation_interval_days" type="number" placeholder="Auto-rotate every N days, e.g. 30" defaultValue={data.rotation_interval_days ?? ""} autoComplete="off" />
<Input id="edit-grace-period" name="grace_period_days" type="number" placeholder="Old key valid N days after rotation, e.g. 7" defaultValue={data.grace_period_days ?? ""} autoComplete="off" />
<Input id="edit-webhook-url" name="webhook_url" type="url" placeholder="POST URL for key events (optional)" defaultValue={data.webhook_url ?? ""} autoComplete="off" />
<Input id="edit-ip-whitelist" name="ip_whitelist" placeholder="CIDR / IP, comma-separated" defaultValue={data.ip_whitelist?.join(", ") ?? ""} autoComplete="off" />
<Input id="edit-ip-blacklist" name="ip_blacklist" placeholder="CIDR / IP, comma-separated" defaultValue={data.ip_blacklist?.join(", ") ?? ""} autoComplete="off" />
```

Add an `aria-describedby`/small helper text under the Expires field is optional; the `title` attribute on `edit-expires-at` above satisfies the "helper" requirement with no layout change.

- [ ] **Step 6: Typecheck + build + tests**

Run: `npm run typecheck && npm run build && bun test app/.server/suggest.test.ts app/.server/tag-utils.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/routes/api-manager.$id.tsx
git commit -m "feat: TagInput + placeholders on edit key form"
```

---

### Task 7: Full verification

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 3: Manual smoke test**

Start the dev server (`npm run dev`), open `/api-manager`:
- Header shows Templates / Groups as outline glass links and Create New Key as the glass primary button, matching other buttons.
- `/api-manager/create`: Allowed Models and Blocked Models render chips; typing shows model (name + provider + "model" badge) and combo (`combo:<name>` + "combo" badge) suggestions; Enter/comma adds chips; Backspace removes; a hidden `allowed_models`/`blocked_models` value is submitted. Selecting "Create from Template" fills the model chips.
- `/api-manager/<id>` → Edit: same behavior, prefilled from existing key values; new placeholders visible on Budget/Quota/Security fields.
- Creating and saving a key round-trips the comma-separated model lists correctly (check the detail page "Allowed models" row).

- [ ] **Step 4: Commit any leftover changes**

```bash
git status
git add -A
git commit -m "chore: api-manager UX polish final"
```
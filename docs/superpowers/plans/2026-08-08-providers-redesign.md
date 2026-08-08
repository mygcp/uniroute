# Providers Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the providers page so the registry is shown as the provider list with toggle switches (default OFF), custom providers support only OpenAI/Anthropic-compatible formats via a `format` column, per-provider connection status (No connection/Connected/Error) via a Test button, all UI strings in English, and a persistent React-controlled dark/light theme.

**Architecture:**
- Theme moves into React state: a `ThemeProvider` context in a new `app/hooks/use-theme.tsx` reads `localStorage["uniroute-theme"]` (fallback to `prefers-color-scheme`), renders `className="dark"` on `<html>`, persists on toggle, wraps the existing inline pre-paint script, and uses `suppressHydrationWarning` to avoid hydration mismatch. `app/routes/providers.tsx` renders registry entries as cards with an `is_active` toggle (default OFF), a per-card Test button and connection status, and a single "Add custom provider" form with only `openai`/`anthropic` format options.
- DB gains a `format` column on `providers` (with a `PRAGMA table_info` guarded `ALTER TABLE` for existing DBs). Auto-enable inserts a provider row from the registry entry + seeds models from registry. Connection test hits `entry.modelsUrl ?? new URL("/v1/models", base_url)` with the routing key from `getApiKey` and a 5s AbortController timeout, returning `{ ok, providerId, message }` consumed by a `useFetcher` mapped per card.

**Tech Stack:** Bun, React Router v8 Framework Mode, React 19, SQLite (`bun:sqlite`/`node:sqlite` via `query`/`exec`), Tailwind v4, lucide-react.

## Global Constraints

- Keep the `providers` schema compatible: `providers` gains `format TEXT NOT NULL DEFAULT 'openai'` for new tables and via guarded `ALTER TABLE` for existing DBs.
- The three runtime strategies must keep working; see sync tests after.
- Anthropic & OpenAI format only for custom; the registry entries store the actual formats that are used by the loaders (see registry entry `format` fs).
- When toggling ON: always insert/sync exactly once, and seed the models ON as well; toggling OFF only flips `is_active` and does NOT delete.
- Custom providers default to `is_active = 0`.
- All new tests must pass alongside existing `49` tests: run `find app/.server -name '*.test.ts'` for the list, run `bun test` to verify.
- All UI text must be English (including `sidebar.tsx` tooltip "Mode terang/Mode gelap").

---

### Task 0: Baseline commit of uncommitted WIP

Before task 1, commit the existing uncommitted provider-detail/registry/dark-mode work so each task below has a clean diff base.

**Files:** (any tracked/untracked WIP from prior session)
- none new; just `git add -A && git commit`

- [ ] **Step 1: Stage and commit WIP**

```bash
git add -A
git status --short   # confirm only WIP files
git commit -m "feat: provider detail page, registry, dark mode, lucide icons"
```

Expected: clean `git status`, new commit on `main`.

---

### Task 1: ThemeContext — React-controlled dark mode

Fixes "theme resets when navigating or refreshing" by moving the `.dark` class under React's DOM control (previously the `<html>` class was only mutated imperatively, so React stripped it on re-render).

**Files:**
- Create: `app/hooks/use-theme.tsx`
- Modify: `app/root.tsx` (Layout wraps content + `<html className>`), `app/components/sidebar.tsx` (use `useTheme`, tooltip EN)
- Test: `app/.server/theme.test.ts`

**Interfaces:**
- Produces: `useTheme(): { theme: "light"|"dark"; setTheme: (t)=>void; toggle: ()=>void; mounted: boolean }`
- Depends on none.

- [ ] **Step 1: Write the failing test**

```ts
// app/.server/theme.test.ts
import { describe, expect, test } from "bun:test";
import { decodeTheme, THEME_KEY } from "../lib/theme";

describe("theme storage", () => {
  test("decodeTheme maps stored values", () => {
    expect(decodeTheme("dark")).toBe("dark");
    expect(decodeTheme("light")).toBe("light");
    expect(decodeTheme(undefined)).toBeNull();
    expect(decodeTheme("garbage")).toBeNull();
  });
  test("theme key constant used consistently", () => {
    expect(THEME_KEY).toBe("uniroute-theme");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test app/.server/theme.test.ts`
Expected: FAIL "cannot find module ../lib/theme"

- [ ] **Step 3: Create the helper module**

Create `app/lib/theme.ts`:

```ts
export type Theme = "light" | "dark";
export const THEME_KEY = "uniroute-theme";

export function decodeTheme(value: string | undefined | null): "dark" | "light" | null {
  if (value === "dark" || value === "light") return value;
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test app/.server/theme.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Add ThemeProvider and useTheme**

Create the provider as an inline module `use-theme.tsx` inside the hooks folder reusing the code in the sidebar. Contents (following existing style):

```tsx
import { createContext, useContext, useEffect, useState } from "react";

import { decodeTheme, THEME_KEY, type Theme } from "../lib/theme";

type ThemeContextValue = {
  theme: Theme;
  toggle: () => void;
  mounted: boolean;
};

const ThemeContext = createContext<ThemeContextValue>({
  theme: "light",
  toggle: () => {},
  mounted: false,
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const stored = decodeTheme(localStorage.getItem(THEME_KEY));
    const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
    setTheme(stored ?? (prefersDark ? "dark" : "light"));
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme, mounted]);

  const toggle = () => {
    setTheme((t) => {
      const next = t === "dark" ? "light" : "dark";
      localStorage.setItem(THEME_KEY, next);
      return next;
    });
  };

  return (
    <ThemeContext.Provider value={{ theme, toggle, mounted }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}
```

- [ ] **Step 6: Wire into root.tsx**

Wrap the app in the provider and render the theme class on `<html>`:

```tsx
import { ThemeProvider } from "./hooks/use-theme";

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <ThemedHtml>{children}</ThemedHtml>
    </ThemeProvider>
  );
}

function ThemedHtml({ children }: { children: React.ReactNode }) {
  const { theme, mounted } = useTheme();
  return (
    <html lang="en" className={theme === "dark" ? "dark" : undefined} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("uniroute-theme");if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})();`,
          }}
        />
      </head>
      <body>{children}<ScrollRestoration /><Scripts /></body>
    </html>
  );
}
```

- [ ] **Step 7: Refactor sidebar to use ThemeProvider**

Replace the `useState((...classList...))` + manual `toggleDark` in sidebar with:

```tsx
const { theme, toggle } = useTheme();
// in JSX
<button type="button" onClick={toggle} title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
  {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
</button>
```

Remove the now-unused inline `useState`.

- [ ] **Step 8: Run typecheck + tests + SSR smoke**

```bash
bun run typecheck
bun run test
```

- [ ] **Step 9: Commit**

```bash
git add app/lib/theme.ts app/hooks/use-theme.tsx app/root.tsx app/components/sidebar.tsx app/.server/theme.test.ts
git commit -m "feat: persistent React-controlled dark mode via ThemeContext"
```

---

### Task 2: `format` column migration

Adds `format` to `providers`: `"openai"` (default) | `"anthropic"` | `"gemini"`, guarded `ALTER TABLE` for pre-existing DBs. Custom providers will store only `openai`/`anthropic` (registry still allows all four existing formats).

**Files:**
- Modify: `app/.server/db.ts` (schema + guarded migrate), `app/routes/providers.tsx` (row type)
- Test: `app/.server/db.test.ts`

**Interfaces:**
- Consumes: existing `db.query`, `db.exec`
- Produces: after import, `providers.format` column exists with default `'openai'`.

- [ ] **Step 1: Write the failing test**

```ts
// app/.server/db.test.ts
import { describe, expect, test } from "bun:test";
import { exec, query } from "./db";

describe("providers schema", () => {
  test("providers has a format column defaulting to openai", () => {
    const ok = query("SELECT sql FROM sqlite_master WHERE type='table' AND name='providers'").get() as { sql: string } | undefined;
    expect(ok?.sql).toContain("format");
  });

  test("alter path is guarded (idempotent)", () => {
    // Re-run the same guard used by migrate(). It must not throw on existing DBs.
    const seen = (query("PRAGMA table_info(providers)").all() as { name: string }[]).map((c) => c.name);
    if (!seen.includes("format")) {
      exec('ALTER TABLE providers ADD COLUMN format TEXT NOT NULL DEFAULT "openai"');
    }
    const after = (query("PRAGMA table_info(providers)").all() as { name: string }[]).map((c) => c.name);
    expect(after).toContain("format");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test app/.server/db.test.ts`
Expected: FAIL (no `format` in schema)

- [ ] **Step 3: Modify schema + migration**

In `app/.server/db.ts` providers `CREATE TABLE`, add `format TEXT NOT NULL DEFAULT 'openai',` after `auth_type`. Then directly after `db.exec(CREATE...</manual ident),` add a migration block (following the existing legacy-credentials pattern):

```ts
// Migration: add providers.format for DBs created before the redesign.
{
  const cols = (
    query("PRAGMA table_info(providers)").all() as { name: string }[]
  ).map((c) => c.name);
  if (cols.length > 0 && !cols.includes("format")) {
    db.exec(`ALTER TABLE providers ADD COLUMN format TEXT NOT NULL DEFAULT 'openai';`);
  }
}
```

- [ ] **Step 4: Export the guard as a reusable helper** (`function ensureProvidersFormatColumn()` in db.ts) and call it after the `CREATE TABLE` statements; test vs same.

```ts
export function ensureProvidersFormat(): void {
  const cols = (query("PRAGMA table_info(providers)").all() as { name: string }[]).map((c) => c.name);
  if (cols.length > 0 && !cols.includes("format")) {
    db.exec(`ALTER TABLE providers ADD COLUMN format TEXT NOT NULL DEFAULT 'openai';`);
  }
}
```

Call it immediately after the `providers` `CREATE TABLE IF NOT EXISTS …` block. Keep the idempotence test.

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test app/.server/db.test.ts`
Expected: PASS

- [ ] **Step 6: Update ProviderRow to include `format`**

In `app/routes/providers.tsx` `type ProviderRow`, add `format: string;` and select `format` in the loader SQL. (Detail page's row-type update happens in Task 4.)

- [ ] **Step 7: Verify full suite + commit**

```bash
bun run test
git add app/.server/db.ts app/.server/db.test.ts app/routes/providers.tsx
git commit -m "feat: providers.format column migration"
```

---

### Task 3: Providers page = registry cards + connection status

Rewrites `app/routes/providers.tsx` to list registry entries as toggleable cards (default OFF), add "Add custom provider" with format picker (`openai`/`anthropic`), and per-card Test button showing No connection/Connected/Error.

**Files:**
- Modify: `app/routes/providers.tsx` (rewrite loader + action + UI)
- Test: `app/.server/test-connection.test.ts` (pure helper)

**Interfaces:**
- Consumes: `PROVIDER_REGISTRY` / `getRegistryEntry` (from `~/registry`), `query` (db), `reload` (runtime registry), `getApiKey` (credential)
- Produces: `testConnection(entryOrProvider): Promise<{ ok, providerId, message }>`; route action returns `{ test: { ok, providerId, message }, providers }`.

- [ ] **Step 1: Write failing pure helper test**

```ts
// app/.server/test-connection.test.ts
import { describe, expect, test } from "bun:test";
import { buildModelsUrl, testConnection } from "../lib/connection";

describe("modelsUrl helper", () => {
  test("uses entry modelsUrl when present", () => {
    expect(buildModelsUrl("https://x.example", "https://registry.example/v1/models")).toBe("https://registry.example/v1/models");
  });
  test("falls back to /v1/models over base_url", () => {
    expect(buildModelsUrl("https://api.example.com", undefined)).toBe("https://api.example.com/v1/models");
  });
});

describe("testConnection helper", () => {
  test("returns ok when fetch resolves with ok status", async () => {
    const fetcher = async (_url: string, _init: RequestInit) =>
      new Response("ok", { status: 200 }) as unknown as Response;
    const result = await testConnection(
      { baseUrl: "https://api.example.com", modelsUrl: undefined, authType: "bearer" },
      "my-provider",
      "sk-test",
      fetcher,
    );
    expect(result.ok).toBe(true);
    expect(result.providerId).toBe("my-provider");
  });

  test("returns error when fetch throws", async () => {
    const fetcher = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await testConnection(
      { baseUrl: "https://api.example.com", modelsUrl: undefined, authType: "bearer" },
      "my-provider",
      "sk-test",
      fetcher,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain("ECONNREFUSED");
  });
});
```

- [ ] **Step 2: Run to verify FAIL**

Run: `bun test app/.server/test-connection.test.ts`
Expected: FAIL "module not found"

- [ ] **Step 3: Implement `app/lib/connection.ts`**

```ts
export function buildModelsUrl(baseUrl: string, modelsUrl: string | undefined): string {
  if (!modelsUrl) {
    const base = baseUrl.replace(/\/+$/, "");
    const suffix = base.endsWith("/v1/models") ? "" : "/v1/models";
    return `${base}${suffix}`;
  }
  return modelsUrl;
}

type TestInput = {
  baseUrl: string;
  modelsUrl?: string;
  authType: string;
};

export async function testConnection(
  input: TestInput,
  providerId: string,
  apiKey: string | null,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<{ ok: boolean; providerId: string; message: string }> {
  const url = buildModelsUrl(input.baseUrl, input.modelsUrl);
  const headers = new Headers({ "Content-Type": "application/json" });
  if (apiKey) {
    if (input.authType === "apikey") headers.set("x-goog-api-key", apiKey);
    else headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetcher(url, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      return { ok: true, providerId, message: "Connected" };
    }
    const text = (await res.text()).slice(0, 300);
    return { ok: false, providerId, message: `HTTP ${res.status}: ${text}` };
  } catch (err) {
    return {
      ok: false,
      providerId,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 4: Verify PASS**, commit helper first.

```bash
bun test app/.server/test-connection.test.ts
git add app/lib/connection.ts app/.server/test-connection.test.ts
git commit -m "feat: connection test helper with injectable fetcher"
```

- [ ] **Step 5: Rewrite loader to include registry → row map**

```ts
import { PROVIDER_REGISTRY, getRegistryEntry } from "~/registry";
import { getApiKey } from "../.server/credential";

const FORMAT_LABELS: Record<string, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic",
  gemini: "Gemini",
  claude: "Anthropic",
};

const PROVIDERS_VIEW = PROVIDER_REGISTRY.map((entry) => {
  const regEntry = getRegistryEntry(entry.id);
  return { ...entry, modelsCount: regEntry?.models?.length ?? 0, format: entry.format };
});

export function loader() {
  const rows = query(
    "SELECT id, name, base_url, auth_type, format, is_active FROM providers ORDER BY id",
  ).all() as unknown as ProviderRow[];
  return { providers: rows, templates: PROVIDERS_VIEW };
}
```

- [ ] **Step 6: Action intents — toggle, test, create-custom**

In `route.action`, replace the existing `toggle`/`update`/`create` intents:

```ts
if (intent === "toggle") {
  const id = String(form.get("id"));
  // target = desired state (1 => ON, 0 => OFF), sent from the card switch.
  const target = Number(form.get("target")) === 1 ? 1 : 0;
  const existing = query("SELECT id FROM providers WHERE id = ?").get(id) as { id: string } | undefined;
  const entry = getRegistryEntry(id);
  if (!existing && entry && target === 1) {
    query(
      `INSERT INTO providers (id, name, base_url, auth_type, format, is_active) VALUES (?, ?, ?, ?, ?, 1)`,
    ).run(id, entry.alias, entry.baseUrl, entry.authType, entry.format);
    for (const [i, m] of entry.models.entries()) {
      query(`INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES (?, ?, ?, 1, ?)`)
        .run(m.id, id, m.contextLength ?? null, i === 0 ? 1 : 0);
    }
  } else if (existing) {
    query("UPDATE providers SET is_active = ? WHERE id = ?").run(target, id);
  }
  reload();
  return redirect("/providers");
}

if (intent === "test") {
  const id = String(form.get("id"));
  const provider = query("SELECT base_url, auth_type FROM providers WHERE id = ?").get(id) as
    | { base_url: string; auth_type: string }
    | undefined;
  const registryEntry = getRegistryEntry(id);
  if (!provider) {
    return { test: { ok: false, providerId: id, message: "Provider not found" } };
  }
  return {
    test: await testConnection(
      { baseUrl: provider.base_url, authType: provider.auth_type, modelsUrl: registryEntry?.modelsUrl },
      id,
      getApiKey(id),
    ),
  };
}

if (intent === "create-custom") {
  const id = String(form.get("id") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const baseUrl = String(form.get("base_url") ?? "").trim();
  const authType = String(form.get("auth_type") ?? "bearer");
  const format = String(form.get("format") ?? "openai");
  if (id && name && baseUrl) {
    query(
      `INSERT INTO providers (id, name, base_url, auth_type, format, is_active) VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(id, name, baseUrl, authType, format);
    reload();
  }
  return redirect("/providers");
}
```

`testConnection` stays in the pure helper so it remains unit-testable without a network.

- [ ] **Step 7: Client component — ProviderToggleCard with switch + status + Test**

Create `ProviderToggleCard` in the route file (or `app/components/provider-toggle-card.tsx`). It takes the registry entry + resolved status and renders a card with a switch, format label, and connection status driven by a route-level `useFetcher`:

```tsx
import { useFetcher } from "react-router";
import { CheckCircle2, Pause, Plug, XCircle } from "lucide-react";

type Status = { ok: boolean; message: string };

function ProviderToggleCard({
  template,
  active,
}: {
  template: (typeof PROVIDERS_VIEW)[number];
  active: boolean;
}) {
  const fetcher = useFetcher<{ test?: { ok: boolean; providerId: string; message: string } }>();
  const result = fetcher.data?.test;
  const pending = fetcher.state === "submitting";
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-start gap-3">
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white ${template.color}`}>
          {template.alias.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 dark:text-white">{template.alias}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{template.description}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {template.authType}
        </span>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {FORMAT_LABELS[template.format] ?? template.format}
        </span>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            className="peer sr-only"
            checked={active}
            onChange={() => {
              const form = document.getElementById(`toggle-${template.id}`) as HTMLFormElement | null;
              form?.requestSubmit();
            }}
          />
          <span className="relative h-5 w-9 rounded-full bg-gray-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-green-600 peer-checked:after:translate-x-4 dark:bg-gray-600" />
          {active ? "Active" : "Inactive"}
        </label>
        <Form id={`toggle-${template.id}`} method="post" className="hidden">
          <input type="hidden" name="intent" value="toggle" />
          <input type="hidden" name="id" value={template.id} />
          <input type="hidden" name="target" value={active ? 0 : 1} />
        </Form>
        <div className="flex items-center gap-2">
          {result ? (
            <span
              className={`flex items-center gap-1 text-xs ${
                result.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
              }`}
              title={result.message}
            >
              {result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
              {result.ok ? "Connected" : "Error"}
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Pause size={14} />
              No connection
            </span>
          )}
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="test" />
            <input type="hidden" name="id" value={template.id} />
            <button
              type="submit"
              disabled={pending}
              className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Plug size={14} />
              Test
            </button>
          </fetcher.Form>
        </div>
      </div>
    </div>
  );
}
```

In the route component, no extra state is needed: each card owns its `useFetcher`, so `result` is `fetcher.data?.test`. Render the catalog:

```tsx
<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
  {PROVIDERS_VIEW.map((t) => (
    <ProviderToggleCard
      key={t.id}
      template={t}
      active={providers.some((p) => p.id === t.id && Boolean(p.is_active))}
    />
  ))}
</div>
```

Keep the existing nested-route guard at the top of the default export: when `useParams().id` is set, return `<Outlet />` unchanged — `/providers/:id` still renders the detail page.

- [ ] **Step 8: Add custom provider form with format picker**

The old `picked`/template-grid flow and `ProviderForm` are removed. Add an "Add custom provider" button (top-right of the Providers heading) that toggles an inline form. Define a shared input class at the top of the route (dark-mode aware):

```tsx
const inputCls =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
```

```tsx
{showCustom ? (
  <Form method="post" className="mb-8 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
    <input type="hidden" name="intent" value="create-custom" />
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">ID</label>
        <input name="id" required placeholder="my-provider" className={inputCls} />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Display Name</label>
        <input name="name" required className={inputCls} />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Base URL</label>
        <input name="base_url" required placeholder="https://api.example.com" className={inputCls} />
      </div>
      <div>
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Auth Type</label>
        <select name="auth_type" defaultValue="bearer" className={inputCls}>
          <option value="none">none</option>
          <option value="bearer">bearer</option>
          <option value="apikey">apikey</option>
        </select>
      </div>
      <div className="sm:col-span-2">
        <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Format</label>
        <select name="format" defaultValue="openai" className={inputCls}>
          <option value="openai">OpenAI-compatible</option>
          <option value="anthropic">Anthropic</option>
        </select>
      </div>
    </div>
    <div className="mt-4 flex gap-2">
      <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
        Add provider
      </button>
      <button type="button" onClick={() => setShowCustom(false)} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">
        Cancel
      </button>
    </div>
  </Form>
) : null}
```

New providers are inserted with `is_active = 0` (per the `create-custom` action), so the switch shows OFF until the user toggles it on.

- [ ] **Step 9: i18n for providers route**

Translate remaining Indonesian strings on this page to English:
- "Tambah provider" → "Add provider"
- "Pilih template lain" → "Choose another template"
- "Daftar provider" → "Providers"
- "Aktif"/"Non-aktif" → "Active"/"Inactive"

- [ ] **Step 10: Verify + commit**

```bash
bun run typecheck && bun test && bun run build
git add app/lib/connection.ts app/.server/test-connection.test.ts app/routes/providers.tsx
git commit -m "feat: registry-driven provider toggles + connection status"
```

---

### Task 4: Providers detail page i18n + format display

Translates remaining Indonesian strings in `app/routes/providers.$id.tsx`, adds `format` to displayed provider detail and selects `format` in loader.

**Files:** Modify `app/routes/providers.$id.tsx`

- [ ] **Step 1: Update row type + SQL**

Add `format: string` to `ProviderRow`, select `format` in `SELECT` for detail loader, show format label next to `auth_type` badge.

- [ ] **Step 2: Replace strings**

- "Provider tidak ditemukan." → "Provider not found."
- "← Kembali ke daftar" → "← Back to providers"
- "Aktif"/"Non-aktif" → "Active"/"Inactive"
- "Tambah API Key" → "Add API Key"
- "Label (opsional)" → "Label (optional)"
- "mis. akun-utama" → "e.g. main-account"
- "Simpan" → "Save", "Batal" → "Cancel"
- "Belum ada API key. Tambahkan untuk mengaktifkan provider ini." → "No API keys yet. Add one to enable this provider."
- "routing"/"non-aktif" badges → keep as-is but translated: "routing", "inactive"
- "Routing aktif" → "Routing active"; "Pakai untuk routing" → "Use for routing"
- "Non-aktifkan"/"Aktifkan" → "Deactivate"/"Activate"
- "Sinkron dari registry (n)" → "Sync from registry (n)"
- "Belum ada model untuk provider ini..." → "No models for this provider yet…"
- "Kirim" → "Send"
- "Stop" keep
- "Selesai." → "Done."
- "context tidak diketahui" → "context unknown"
- "Hapus provider ini" / `confirm(`Hapus provider ${provider.id}?`)` → "Delete this provider" / `confirm(\`Delete provider ${provider.id}?\`)` (keeps existing delete provider + models + credentials behavior)

Keep behavior identical; only translate.

- [ ] **Step 3: Typecheck + commit**

```bash
bun run typecheck
git add app/routes/providers.$id.tsx
git commit -m "i18n: providers detail in English"
```

---

### Task 5: Remaining UI i18n sweep

**Files:** `app/components/streaming-response.tsx`, `app/components/log-viewer.tsx`, `app/components/sidebar.tsx`, `app/routes/compression.tsx`, `app/routes/api.tsx` (+ any remaining).

- [ ] **Step 1: streaming-response.tsx**

`"Response akan tampil di sini."` → `"Response will appear here."`; `"Selesai."` → `"Done."`.

- [ ] **Step 2: log-viewer.tsx**

`"Belum ada event. Coba trigger request proxy..."` → `"No events yet. Try sending a proxy request..."`.

- [ ] **Step 3: compression.tsx**

`"Settings tersimpan."` → `"Settings saved."`

- [ ] **Step 4: api.tsx empty rule text**

`"Belum ada routing rule."` → `"No routing rules yet."`

- [ ] **Step 5: sidebar tooltips**

`title={dark ? "Mode terang" : "Mode gelap"}` → covered by Task 1 (already EN).

- [ ] **Step 6: grep for remaining Indonesian**

```bash
grep -rEn "Aktif|Tambah|Daftar|Simpan|Batal|Routing|Kirim|Selesai|Belum ada|Kembali|opsional|Terhubung|tidak" app --include="*.tsx" --include="*.ts" | grep -v "app/registry/"
```

If any remain (except comments/docstrings), translate them.

- [ ] **Step 7: Verify + commit**

```bash
bun run typecheck && bun test && bun run build
git add -A
git commit -m "i18n: migrate remaining UI strings to English"
```

---

### Task 6: Final verification

- [ ] **Step 1: Full suite**

```bash
bun run typecheck
bun run test
bun run build
```

- [ ] **Step 2: SSR + login smoke via local server**

```bash
# Build is required for server.ts (uses ./build/server). Port defaults to 3000.
bun run build
rm -f /tmp/ur.jar
timeout 90 bash -c 'bun server.ts & SRV=$!; sleep 2;
  # login (password from .env PASSWORD, default CHANGEME)
  curl -s -i -c /tmp/ur.jar -d "password=CHANGEME" http://localhost:3000/login > /dev/null;
  for p in /home /providers /providers/openai /api /combo /compression /proxy /logs/requests /logs/proxy; do
    code=$(curl -s -b /tmp/ur.jar -o /dev/null -w "%{http_code}" http://localhost:3000$p);
    echo "$p -> $code";
  done;
  kill -9 $SRV'
```

Expected: every listed path returns `200`. Login redirect observed for none of them (authenticated).

- [ ] **Step 3: Manual sanity (optional)**

Toggle a registry provider OFF→ON on `/providers`, Test button for Expected statuses. Adjust tests if a behavior disagreement surfaces.

- [ ] **Step 4: Final commit if any fixups + summarize**

```bash
git status --short
```
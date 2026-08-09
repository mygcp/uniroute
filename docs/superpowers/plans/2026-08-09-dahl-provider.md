# Dahl Global Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Dahl Global as a new OpenAI-compatible provider in UniRoute (registry entry + DB seed + reconciliation + tests) so it shows in "Daftar provider" and routes chats with `Authorization: Bearer`.

**Architecture:** Mirror the already-committed OpenCode Zen integration. Dahl gets its own registry entry (`app/registry/dahl.ts`) registered in the registry index, a Bearer auth entry (the OpenAI-compatible path), and a DB seed + `ensureDahlProvider()` reconciliation function paralleling `ensureOpenCodeProvider()`. Adapter and `testProvider` already handle `auth_type === "bearer"` and `urlSuffix` (built in the Zen work), so no changes there. Provider templates are untouched (only openai/anthropic qualify).

**Tech Stack:** TypeScript, React Router, Bun test runner, SQLite via `bun:sqlite` (wrapped by `query`/`exec` in `app/.server/db.ts`).

## Global Constraints

- Dahl auth is **Bearer** (`Authorization: Bearer <key>`); the entry uses `authType: "bearer"` — do NOT use `apikey` (that maps to `x-goog-api-key` in the adapter, which is Google-specific and wrong for Dahl).
- `base_url` must be `https://inference.dahl.global/v1` with `urlSuffix: "chat/completions"` so the adapter emits `https://inference.dahl.global/v1/chat/completions` (the `/v1` path is preserved by the urlSuffix join).
- Live models for `app/registry/dahl.ts` and the seed (exact ids): `MiniMaxAI/MiniMax-M2.7`, `moonshotai/Kimi-K2.6`. Context length for both: `200000` (live endpoint gives no context numbers).
- Provider seeds as `is_active = 0` (inactive), admin enables via UI.
- `app/components/provider-templates.tsx` is out of scope: Dahl must NOT appear in "Tambah provider" templates.
- Adapter and `testProvider` are out of scope (already handle bearer + urlSuffix).
- Verification commands: `npm test` (expect all pass, currently 74), `npm run typecheck`, `npm run build`.

---

### Task 1: Create the Dahl registry entry and register it

**Files:**
- Create: `app/registry/dahl.ts`
- Modify: `app/registry/index.ts`

**Interfaces:**
- Consumes: `RegistryEntry` type from `~/types` (`id`, `alias`, `free`, `authType`, `baseUrl`, `format`, `models`, `urlSuffix?`, `modelsUrl?`, `description?`, `color?`).
- Produces: exported `DAHL_ENTRY: RegistryEntry` with `id: "dahl"`; registered in `PROVIDER_REGISTRY` so `getRegistryEntry("dahl")` returns it.

- [ ] **Step 1: Create `app/registry/dahl.ts`**

```ts
import type { RegistryEntry } from "~/types";

export const DAHL_ENTRY: RegistryEntry = {
  id: "dahl",
  alias: "Dahl Global",
  free: false,
  authType: "bearer",
  baseUrl: "https://inference.dahl.global/v1",
  urlSuffix: "chat/completions",
  format: "openai",
  description: "Dahl Global inference, OpenAI-compatible",
  color: "bg-purple-600",
  modelsUrl: "https://inference.dahl.global/v1/models",
  models: [
    { id: "MiniMaxAI/MiniMax-M2.7", name: "MiniMax M2.7", contextLength: 200000 },
    { id: "moonshotai/Kimi-K2.6", name: "Kimi K2.6", contextLength: 200000 },
  ],
};
```

- [ ] **Step 2: Register it in `app/registry/index.ts`**

Add the import (alphabetically by module path: `./custom` → `./dahl` → `./deepseek`) and the array entry:

```ts
import { CUSTOM_ENTRY } from "./custom";
import { DAHL_ENTRY } from "./dahl";
import { DEEPSEEK_ENTRY } from "./deepseek";
```

```ts
export const PROVIDER_REGISTRY: RegistryEntry[] = [
  OPENAI_ENTRY,
  ANTHROPIC_ENTRY,
  NVIDIA_NIM_ENTRY,
  CLOUDFLARE_ENTRY,
  GROQ_ENTRY,
  MISTRAL_ENTRY,
  XAI_ENTRY,
  GEMINI_ENTRY,
  DEEPSEEK_ENTRY,
  OLLAMA_ENTRY,
  LMSTUDIO_ENTRY,
  DAHL_ENTRY,
  OPENCODE_ENTRY,
  CUSTOM_ENTRY,
];
```

- [ ] **Step 3: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/registry/dahl.ts app/registry/index.ts
git commit -m "feat: add Dahl Global registry entry"
```

---

### Task 2: Seed Dahl into the DB and reconcile existing installations

**Files:**
- Modify: `app/.server/db.ts`

**Interfaces:**
- Consumes: `query` from the same module.
- Produces: provider `dahl` (`auth_type = 'bearer'`, `is_active = 0`, base_url `https://inference.dahl.global/v1`) + the two live models, both via the main `seed()` and a new `ensureDahlProvider()` reconciliation function called at module load (after `seed()` and `ensureOpenCodeProvider()`).

- [ ] **Step 1: Add Dahl to the main seed provider rows**

In `app/.server/db.ts`, inside `seed()`, add the Dahl provider insert directly after the `opencode` provider insert (lines 292-300):

```ts
    insertProvider.run(
      "dahl",
      "Dahl Global",
      "https://inference.dahl.global/v1",
      "bearer",
      0,
      1,
      0,
    );
```

- [ ] **Step 2: Add Dahl to the main seed model list**

In the `models` array inside `seed()`, add these two entries (the model ids contain a `/` — that is fine, the column is TEXT; tuple format is `[name, provider, ctx, active, primary]`, and one model gets `is_primary = 1` like `big-pickle` does for opencode):

```ts
      ["moonshotai/Kimi-K2.6", "dahl", 200000, 1, 1],
      ["MiniMaxAI/MiniMax-M2.7", "dahl", 200000, 1, 0],
```

(Add them at the end of the array, after the opencode rows.)

- [ ] **Step 3: Add `ensureDahlProvider()`**

Add this function after `ensureOpenCodeProvider()`:

```ts
export function ensureDahlProvider() {
  query(
    `INSERT OR IGNORE INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
     VALUES ('dahl', 'Dahl Global', 'https://inference.dahl.global/v1', 'bearer', 0, 1, 0)`,
  ).run();
  query(
    "UPDATE providers SET auth_type = 'bearer' WHERE id = 'dahl' AND auth_type != 'bearer'",
  ).run();
  const dahlModels: [string, number][] = [
    ["moonshotai/Kimi-K2.6", 200000],
    ["MiniMaxAI/MiniMax-M2.7", 200000],
  ];
  for (const [name, ctx] of dahlModels) {
    query(
      `INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary)
       VALUES (?, 'dahl', ?, 1, CASE WHEN NOT EXISTS
         (SELECT 1 FROM models WHERE provider_id = 'dahl' AND is_primary = 1) THEN 1 ELSE 0 END)`,
    ).run(name, ctx);
  }
}
```

- [ ] **Step 4: Call it at module load**

At the bottom of `app/.server/db.ts`, change the module-load section to:

```ts
seed();

ensureOpenCodeProvider();

ensureDahlProvider();
```

- [ ] **Step 5: Run the existing tests**

Run: `npm test`
Expected: all pass (currently 74). (No new DB behavior is asserted yet — the add tests in Task 3.)

- [ ] **Step 6: Commit**

```bash
git add app/.server/db.ts
git commit -m "feat: seed Dahl Global provider with Bearer auth"
```

---

### Task 3: Add registry and adapter tests for Dahl

**Files:**
- Test: `app/.server/registry.test.ts`
- Test: `app/.server/adapter.test.ts`

**Interfaces:**
- Consumes: `reg.reload`, `reg.getProviders`, `db.seed`, `db.query`, `db.ensureDahlProvider`, `transformRequest`, `setApiKey`/`deleteApiKey`, `exec`.
- Produces: tests asserting Dahl seeding/mapping and Bearer URL construction.

- [ ] **Step 1: Add a registry test for Dahl**

In `app/.server/registry.test.ts`, inside the `describe("registry", ...)` block, add two tests (after the opencode tests):

```ts
  test("dahl is seeded as a Bearer provider and maps its models", () => {
    db.seed();
    db.ensureDahlProvider();
    db.query("UPDATE providers SET is_active = 1 WHERE id = 'dahl'").run();
    reg.reload();
    expect(reg.getProviders("moonshotai/Kimi-K2.6").length).toBe(1);
    const direct = reg.getProviders("MiniMaxAI/MiniMax-M2.7");
    expect(direct.length).toBe(1);
    expect(direct[0].id).toBe("dahl");
    expect(direct[0].base_url).toBe("https://inference.dahl.global/v1");
    expect(direct[0].auth_type).toBe("bearer");
    db.query("UPDATE providers SET is_active = 0 WHERE id = 'dahl'").run();
    reg.reload();
  });

  test("dahl model list matches live models", () => {
    const rows = db.query(
      "SELECT model_name FROM models WHERE provider_id = 'dahl' ORDER BY model_name",
    ).all() as unknown as { model_name: string }[];
    expect(rows.map((r) => r.model_name)).toEqual([
      "MiniMaxAI/MiniMax-M2.7",
      "moonshotai/Kimi-K2.6",
    ]);
  });
```

- [ ] **Step 2: Run the registry tests**

Run: `bun test ./app/.server/registry.test.ts`
Expected: all pass.

- [ ] **Step 3: Add an adapter test for Dahl**

In `app/.server/adapter.test.ts`, inside the `transformRequest` describe block, add:

```ts
  test("dahl bearer provider uses urlSuffix and Authorization Bearer", () => {
    setApiKey("dahl", "dahl-key");
    const { url, headers } = transformRequest(
      { model: "moonshotai/Kimi-K2.6" },
      {
        ...TEST_PROVIDER,
        id: "dahl",
        base_url: "https://inference.dahl.global/v1",
        auth_type: "bearer",
      },
    );
    expect(url).toBe("https://inference.dahl.global/v1/chat/completions");
    expect(headers.get("Authorization")).toBe("Bearer dahl-key");
    expect(headers.get("x-goog-api-key")).toBeNull();
    deleteApiKey("dahl");
  });
```

Note: `setApiKey`/`deleteApiKey` are already imported in this file (used by the existing opencode/bearer tests). Add `deleteApiKey("dahl")` inside the test (matching the `test-apikey` pattern) and extend the `afterAll` cleanup to cover `"dahl"`:

```ts
  afterAll(() => {
    deleteApiKey("test-provider");
    deleteApiKey("test-apikey");
    deleteApiKey("dahl");
    exec("DELETE FROM provider_credentials WHERE provider_id IN ('test-provider', 'test-apikey', 'dahl')");
  });
```

- [ ] **Step 4: Run the adapter tests**

Run: `bun test ./app/.server/adapter.test.ts`
Expected: all pass, including the new Dahl test.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass (now 77).

- [ ] **Step 6: Run typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no errors, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/.server/registry.test.ts app/.server/adapter.test.ts
git commit -m "test: add Dahl provider registry and adapter coverage"
```

---

### Task 4: Final verification

**Files:**
- Verify only: no new files.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all pass (77), 0 fail.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit any remaining changes**

```bash
git status
git add -A
git commit -m "chore: finalize Dahl Global provider integration"
```
(Only if there are uncommitted changes; otherwise skip.)
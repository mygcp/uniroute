# OpenCode Zen Free/No-Key Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenCode Zen provider work anonymously (no API key) by switching it to `authType: "none"`, fixing the outbound URL so the `/zen` path is preserved, and syncing seeded models to the live Zen model list.

**Architecture:** The registry entry (`app/registry/opencode.ts`) drives auth and URL behavior. The adapters build the outbound URL; the only generic change is honoring the existing-but-unused `urlSuffix` field so base URLs with path segments (like `/zen/v1`) survive. Seed and reconciliation in `app/.server/db.ts` keep the DB in sync for both fresh and existing installations.

**Tech Stack:** TypeScript, React Router, Bun (runtime + test runner), SQLite via Bun's `bun:sqlite`.

## Global Constraints

- OpenCode Zen requires **no API key**: `authType: "none"`, and the adapter must never send an auth header for it.
- Outbound chat URL must be `https://opencode.ai/zen/v1/chat/completions` (the `/zen` segment must be preserved).
- `hy3-free` is removed from the live model list; new free models are `ling-3.0-flash-free`, `ling-3.0-tiny-free`, `laguna-s-2.1-free`, `longcat-2.0-free`.
- Existing seeded context-length values for opencode models are kept unchanged; new models use `200000`.
- `provider-templates.tsx` is out of scope: opencode must NOT appear in "Tambah provider" templates.
- Verification commands: `npm test` (71+ tests, all pass), `npm run typecheck`, `npm run build`.

---

### Task 1: Point the OpenCode registry entry at free/no-key with a URL suffix

**Files:**
- Modify: `app/registry/opencode.ts`
- Verify: typecheck

**Interfaces:**
- Consumes: `RegistryEntry` type from `~/types` — `authType: "none" | "apikey" | "bearer" | "oauth"`, `urlSuffix?: string`.
- Produces: `OPENCODE_ENTRY` with `authType: "none"`, `urlSuffix: "chat/completions"`, no `authHeader`/`authPrefix`, synced model list.

- [ ] **Step 1: Edit `app/registry/opencode.ts`**

Change the top of the entry:

```ts
export const OPENCODE_ENTRY: RegistryEntry = {
  id: "opencode",
  alias: "OpenCode Zen",
  format: "openai",
  authType: "none",
  baseUrl: "https://opencode.ai/zen/v1",
  modelsUrl: "https://opencode.ai/zen/v1/models",
  urlSuffix: "chat/completions",
  passthroughModels: true,
  defaultContextLength: 200000,
  free: true,
  description: "OpenCode ZEN gateway (OpenAI-compatible, no API key)",
  color: "bg-slate-500",
  models: [
    {
      id: "big-pickle",
      name: "Big Pickle",
      supportsReasoning: true,
      interleavedField: "reasoning_content",
    },
    {
      id: "deepseek-v4-flash-free",
      name: "DeepSeek V4 Flash Free",
      supportsReasoning: true,
    },
    { id: "mimo-v2.5-free", name: "MiMo V2.5 Free", contextLength: 131000 },
    { id: "ling-3.0-flash-free", name: "Ling 3.0 Flash Free" },
    { id: "ling-3.0-tiny-free", name: "Ling 3.0 Tiny Free" },
    {
      id: "nemotron-3-ultra-free",
      name: "Nemotron 3 Ultra Free",
      contextLength: 1000000,
    },
    {
      id: "north-mini-code-free",
      name: "North Mini Code Free",
      contextLength: 131000,
    },
    { id: "laguna-s-2.1-free", name: "Laguna S 2.1 Free" },
    { id: "longcat-2.0-free", name: "Longcat 2.0 Free" },
  ],
};
```

Note: `hy3-free` removed; four new free models added; `authType` is `"none"`; `urlSuffix: "chat/completions"` (this is what the adapter joins onto `baseUrl`); no `authHeader`/`authPrefix`; no `executor` field (we use the OpenAI-format path, not a custom executor).

- [ ] **Step 2: Verify typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add app/registry/opencode.ts
git commit -m "feat: make OpenCode Zen entry free with no API key"
```

---

### Task 2: Honor `urlSuffix` in the adapter so path segments survive

**Files:**
- Modify: `app/.server/adapter.ts:11-33`
- Test: `app/.server/adapter.test.ts`

**Interfaces:**
- Consumes: `Provider` (`{ id, base_url, auth_type, ... }`) from `./registry`, `getRegistryEntry` from `~/registry`, `getApiKey` from `./credential`.
- Produces: unchanged `transformRequest(body, provider): TransformResult` — now returns a URL that preserves `provider.base_url` path segments when the registry entry defines `urlSuffix`.

- [ ] **Step 1: Write the failing tests**

In `app/.server/adapter.test.ts`, **replace** the existing test `"opencode entry uses Authorization Bearer via authHeader"` (currently lines 44-53, which sets a key on `opencode` and expects `Authorization: Bearer`) — it will no longer be valid because the entry now has `authType: "none"` and no `authHeader`. Replace it with the two tests below, inserted inside the `transformRequest` describe block (keep the existing `afterAll` as is). The `model` in the body is a passthrough string; use `"deepseek-v4-flash-free"`.

```ts
  test("opencode uses urlSuffix to keep the /zen path and sends no auth header", () => {
    deleteApiKey("opencode");
    deleteApiKey("opencode");
    const { url, headers } = transformRequest(
      { model: "deepseek-v4-flash-free" },
      {
        ...TEST_PROVIDER,
        id: "opencode",
        base_url: "https://opencode.ai/zen/v1",
        auth_type: "none",
      },
    );
    expect(url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("x-goog-api-key")).toBeNull();
  });

  test("provider without urlSuffix keeps the fallback /v1/chat/completions URL", () => {
    deleteApiKey("test-provider");
    const { url, headers } = transformRequest(
      { model: "gpt-4o" },
      TEST_PROVIDER,
    );
    expect(url).toBe("https://mock.example.com/v1/chat/completions");
    expect(headers.get("Authorization")).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test ./app/.server/adapter.test.ts`
Expected: the first new test FAILS (URL is `https://opencode.ai/v1/chat/completions`, `/zen` dropped). The second may pass already (independent of the change).

- [ ] **Step 3: Implement `urlSuffix` fallback in the adapter**

Replace the URL construction at `app/.server/adapter.ts:15` and hoist the entry lookup so it is available for both URL and headers:

```ts
export function transformRequest(
  body: Record<string, unknown>,
  provider: Provider,
): TransformResult {
  const entry = getRegistryEntry(provider.id);
  const url = entry?.urlSuffix
    ? `${provider.base_url.replace(/\/+$/, "")}/${entry.urlSuffix}`
    : new URL("/v1/chat/completions", provider.base_url).toString();
  const headers = new Headers({ "Content-Type": "application/json" });

  if (entry?.authHeader) {
    const key = getApiKey(provider.id);
    if (key) {
      headers.set(entry.authHeader, `${entry.authPrefix ?? ""} ${key}`.trim());
    }
  } else if (provider.auth_type === "bearer") {
    const key = getApiKey(provider.id);
    if (key) headers.set("Authorization", `Bearer ${key}`);
  } else if (provider.auth_type === "apikey") {
    const key = getApiKey(provider.id);
    if (key) headers.set("x-goog-api-key", key);
  }

  return { url, headers, body: JSON.stringify(body) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test ./app/.server/adapter.test.ts`
Expected: all tests PASS, including both new ones.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass (71+).

- [ ] **Step 6: Commit**

```bash
git add app/.server/adapter.ts app/.server/adapter.test.ts
git commit -m "fix(adapter): preserve base_url path via urlSuffix"
```

---

### Task 3: Sync the DB seed and reconcile existing installations

**Files:**
- Modify: `app/.server/db.ts:292-300` (seed provider), `app/.server/db.ts:302-316` (seed models), `app/.server/db.ts:351-371` (`ensureOpenCodeProvider`)
- Test: `app/.server/registry.test.ts`

**Interfaces:**
- Consumes: nothing new; uses `query` from `./db`.
- Produces: provider `opencode` with `auth_type = 'none'`; models synced to the live list; `hy3-free` set `is_active = 0` on existing DBs.

- [ ] **Step 1: Update the main seed provider row**

In `app/.server/db.ts`, the opencode provider insert (currently `auth_type: "apikey"` around line 296):

```ts
    insertProvider.run(
      "opencode",
      "OpenCode Zen",
      "https://opencode.ai/zen/v1",
      "none",
      0,
      1,
      0,
    );
```

- [ ] **Step 2: Update the seed model list**

In the `models` array, replace the opencode rows with (drop `hy3-free`, add the four new models):

```ts
      ["big-pickle", "opencode", 200000, 1, 1],
      ["deepseek-v4-flash-free", "opencode", 200000, 1, 0],
      ["mimo-v2.5-free", "opencode", 131000, 1, 0],
      ["ling-3.0-flash-free", "opencode", 200000, 1, 0],
      ["ling-3.0-tiny-free", "opencode", 200000, 1, 0],
      ["nemotron-3-ultra-free", "opencode", 1000000, 1, 0],
      ["north-mini-code-free", "opencode", 131000, 1, 0],
      ["laguna-s-2.1-free", "opencode", 200000, 1, 0],
      ["longcat-2.0-free", "opencode", 200000, 1, 0],
```

- [ ] **Step 3: Reconcile existing DBs in `ensureOpenCodeProvider`**

Replace the body of `ensureOpenCodeProvider()` in `app/.server/db.ts`:

```ts
export function ensureOpenCodeProvider() {
  query(
    `INSERT OR IGNORE INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
     VALUES ('opencode', 'OpenCode Zen', 'https://opencode.ai/zen/v1', 'none', 0, 1, 0)`,
  ).run();
  query(
    "UPDATE providers SET auth_type = 'none' WHERE id = 'opencode' AND auth_type != 'none'",
  ).run();
  const opencodeModels: [string, number][] = [
    ["big-pickle", 200000],
    ["deepseek-v4-flash-free", 200000],
    ["mimo-v2.5-free", 131000],
    ["ling-3.0-flash-free", 200000],
    ["ling-3.0-tiny-free", 200000],
    ["nemotron-3-ultra-free", 1000000],
    ["north-mini-code-free", 131000],
    ["laguna-s-2.1-free", 200000],
    ["longcat-2.0-free", 200000],
  ];
  for (const [name, ctx] of opencodeModels) {
    query(
      `INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary)
       VALUES (?, 'opencode', ?, 1, CASE WHEN NOT EXISTS
         (SELECT 1 FROM models WHERE provider_id = 'opencode' AND is_primary = 1) THEN 1 ELSE 0 END)`,
    ).run(name, ctx);
  }
  query(
    "UPDATE models SET is_active = 0 WHERE model_name = 'hy3-free' AND provider_id = 'opencode'",
  ).run();
}
```

- [ ] **Step 4: Write tests for the seeded/reconciled state**

In `app/.server/registry.test.ts`, replace the opencode test (currently around line 50) with an expanded version:

```ts
  test("opencode is seeded as a free provider and maps its models", () => {
    db.seed();
    db.query("UPDATE providers SET is_active = 1 WHERE id = 'opencode'").run();
    reg.reload();
    expect(reg.getAnyProvider("big-pickle").length).toBe(1);
    const direct = reg.getProviders("big-pickle");
    expect(direct.length).toBe(1);
    expect(direct[0].id).toBe("opencode");
    expect(direct[0].base_url).toBe("https://opencode.ai/zen/v1");
    expect(direct[0].auth_type).toBe("none");
    db.query("UPDATE providers SET is_active = 0 WHERE id = 'opencode'").run();
    reg.reload();
  });

  test("opencode model list matches live Zen free models", () => {
    const rows = db.query(
      "SELECT model_name, is_active FROM models WHERE provider_id = 'opencode' ORDER BY model_name",
    ).all() as unknown as { model_name: string; is_active: number }[];
    expect(rows.map((r) => r.model_name)).toEqual([
      "big-pickle",
      "deepseek-v4-flash-free",
      "laguna-s-2.1-free",
      "ling-3.0-flash-free",
      "ling-3.0-tiny-free",
      "longcat-2.0-free",
      "mimo-v2.5-free",
      "nemotron-3-ultra-free",
      "north-mini-code-free",
    ]);
    expect(rows.every((r) => r.is_active === 1)).toBe(true);
  });

  test("ensureOpenCodeProvider deactivates legacy hy3-free model", () => {
    db.query(
      "INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary) VALUES ('hy3-free', 'opencode', 131000, 1, 0)",
    ).run();
    db.ensureOpenCodeProvider();
    const hy3 = db.query(
      "SELECT is_active FROM models WHERE model_name = 'hy3-free' AND provider_id = 'opencode'",
    ).get() as { is_active: number };
    expect(hy3.is_active).toBe(0);
    db.query("DELETE FROM models WHERE model_name = 'hy3-free'").run();
  });
```

Note: `hy3-free` remains in the models table (set inactive), so the second test asserts it exists with `is_active = 0` rather than asserting absence. The `direct[0]` type is `Provider` which has `auth_type` — no type cast needed since `registry.test.ts` reads rows via `reg`.

- [ ] **Step 5: Run the tests**

Run: `bun test ./app/.server/registry.test.ts`
Expected: all PASS.

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add app/.server/db.ts app/.server/registry.test.ts
git commit -m "feat: seed OpenCode Zen as free provider with synced models"
```

---

### Task 4: Let the provider list test free/no-key providers anonymously

**Files:**
- Modify: `app/routes/providers.tsx:33-79`

**Interfaces:**
- Consumes: `provider.auth_type`, `entry.modelsUrl`, `query`, `listApiKeys`.
- Produces: `testProvider(providerId): Promise<{ connected: number; total: number }>` — for `auth_type === "none"` performs an anonymous GET to the models URL instead of requiring stored keys.

- [ ] **Step 1: Edit `testProvider`**

In `app/routes/providers.tsx`, replace the function so it short-circuits for keyless providers:

```ts
function testProvider(providerId: string): Promise<{ connected: number; total: number }> {
  const provider = query(
    "SELECT base_url, auth_type FROM providers WHERE id = ?",
  ).get(providerId) as { base_url: string; auth_type: string } | undefined;
  if (!provider) return Promise.resolve({ connected: 0, total: 0 });

  const entry = getRegistryEntry(providerId);
  const modelsUrl =
    entry?.modelsUrl ?? new URL("/v1/models", provider.base_url).toString();

  if (provider.auth_type === "none") {
    return (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(modelsUrl, { signal: controller.signal });
        clearTimeout(timer);
        return { connected: res.ok ? 1 : 0, total: 1 };
      } catch {
        return { connected: 0, total: 1 };
      }
    })();
  }

  const keys = listApiKeys(providerId).filter((k) => k.is_active);
  if (keys.length === 0) return Promise.resolve({ connected: 0, total: 0 });
  ...
}
```

Keep the remaining key-based logic (from `const keys` downward through the existing async fetch loop) unchanged.

- [ ] **Step 2: Verify typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: no errors.

- [ ] **Step 3: Manual verification against live Zen**

Run:
```bash
node -e "fetch('https://opencode.ai/zen/v1/models').then(r=>console.log('live models HTTP', r.status)).catch(e=>console.error(e))"
```
Expected: prints `live models HTTP 200` — confirming the anonymous test URL works.

- [ ] **Step 4: Commit**

```bash
git add app/routes/providers.tsx
git commit -m "feat: test provider connectivity anonymously for free providers"
```

---

### Task 5: Final verification

**Files:**
- Verify only: no new files.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all pass (71+), 0 fail.

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Confirm outbound URL fix**

Run:
```bash
node -e "console.log('https://opencode.ai/zen/v1'.replace(/\/+$/,'') + '/chat/completions')"
```
Expected: `https://opencode.ai/zen/v1/chat/completions`.

- [ ] **Step 5: Commit any remaining changes**

```bash
git status
git add -A
git commit -m "chore: finalize OpenCode Zen free integration"
```
(Only if there are uncommitted changes; otherwise skip.)
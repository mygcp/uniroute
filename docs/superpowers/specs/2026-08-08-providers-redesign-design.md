# Providers Page Redesign — Design Spec

Date: 2026-08-08
Status: Approved (user confirmed)

## Problem Statement

The `/providers` page and surrounding UI have the following issues:

1. **Dark/light mode resets on navigation or refresh** — the `.dark` class is
   added to `document.documentElement` outside React, so React's VDOM for
   `<html>` removes it on re-render after client-side navigation.
2. **UI still contains Indonesian strings** mixed with English.
3. **Provider creation UI is a 12-card template grid**, but the user wants the
   registry entries shown directly as the provider list (with toggle switches).
4. **Custom provider add flow** should offer only 2 formats:
   `OpenAI-compatible` and `Anthropic` (not "custom" free-form).
5. **Default switch state for providers is OFF**, not ON.
6. Provider cards need a **connection status**: `No connection` (pause icon,
   gray), `Connected` (green), `Error` (red), driven by a **Test** button
   that hits the registry `/v1/models` URL with the routing API key.

## Architecture

| Area | Change |
| ---- | ------ |
| Theme | Move theme into React state at root (context provider), render `className` on `<html>` via React, keep localStorage persistence + pre-paint script, use `suppressHydrationWarning` |
| Provider list | `app/routes/providers.tsx` renders registry cards with switch + status + test badge |
| Provider form/`create` intent | Format options restricted to `openai` / `anthropic`, default `is_active = 0` for new providers |
| DB | Add `format` column to `providers`, seeded from registry; toggle-on inserts provider + seeds models from registry |
| Connection status | Per-card Test button → action hits registry/`/v1/models` with routing key, returns ok/error to update UI state |
| i18n | All UI strings → English |

## Implementation

### Theme (root.tsx, sidebar.tsx, app.css)

- Create `app/hooks/use-theme.tsx` (or inline in `app/root.tsx`):

  - `ThemeProvider` holding `theme` state (`"light" | "dark"`).
  - Read initial from `localStorage` (key `uniroute-theme`) and set `.dark`
    class on `<html>`.
  - `useEffect` listens to changes and persists.

- In `root.tsx`:

  - Load theme before first paint (if possible via SSR + localStorage).
  - Move the dark variable to a `<ThemeProvider>` that wraps `<App>`.
  - Ensure `<html className={theme}>`.

- In `sidebar.tsx`:

  - Replace the local `useState` toggle with `useTheme()` from provider
  - Icon stays `${dark ? "Sun" : "Moon"}` from lucide.

### Providers page

`app/routes/providers.tsx`:

- Loader: fetch registry entries (static) + DB providers.
- Render each registry entry as a card:
  - name, id, auth badge, description, format badge.
  - toggle switch (default OFF unless DB row `is_active=1`).
  - Test button → local state + fetcher POST to action.
  - Status: `No connection` (gray) / `Connected` (green) / `Error` (red).
- Add provider form:
  - Only accepts format `openai` / `anthropic`.
  - Hidden `template_id` seeded from registry, but the actual create action
    validates format values.
- Action:
  - When a registry card is toggled ON and no DB row exists, `INSERT` provider
    from registry entry (id, name, base_url, auth_type, model rows) and set
    `is_active=1`.
  - When toggled OFF → update `is_active=0`.

### DB / types

`app/.server/db.ts`:

- `providers` gains a `format` column (`TEXT NOT NULL DEFAULT 'openai'`).
- For existing DBs, add it via `ALTER TABLE providers ADD COLUMN format TEXT NOT NULL DEFAULT 'openai'` guarded by a `PRAGMA table_info(providers)` existence check (safe re-run).
- Create/update `intent` in `providers.tsx` writes `format`.

`app/types/index.ts`:

- (No breaking change; registry entry already has `format`.)

### Connection status

In `app/routes/providers.tsx` action:

- `intent=test`, reads provider id → build URL =
  `provider.registry.modelsUrl ?? new URL("/v1/models", baseUrl)`.
- Grab routing key with same `getApiKey` from runtime.
- `fetch` with 5s timeout (AbortController) → status.
- Return `{ ok: boolean, okId: string, message }`.

The provider card UI uses `useFetcher` + local state to display:

- gray pause icon + "No connection"
- green check + "Connected"   when ok
- red x + "Error" (message shown in title)

### i18n audit

- Replace Indonesian with English across:
  - `app/routes/providers.tsx` — "Aktif/Non-aktif" → "Active/Inactive", "Daftar provider" → "Providers", "Tambah provider" → "Add provider", "Pilih template lain" → "Choose another template".
  - `app/routes/providers.$id.tsx` — "Tambah API Key" → "Add API Key", "Simpan" → "Save", "Batal" → "Cancel", "Pakai untuk routing" → "Use for routing", "Routing aktif" → "Routing active", "Non-aktifkan/Aktifkan" → "Deactivate/Activate", "Sinkron dari registry" → "Sync from registry", "Hapus provider ini" → "Delete this provider", "Belum ada model" → "No models yet", empty states.
  - `app/routes/compression.tsx` — "Settings tersimpan" → "Settings saved".
  - `app/components/streaming-response.tsx` — "Response akan tampil di sini" → "Response will appear here.", "Selesai." → "Done.".
  - `app/components/log-viewer.tsx` — "Belum ada event" → "No events yet".
  - `app/routes/api.tsx` — "Belum ada routing rule." → "No routing rules yet.".

## Errors / edge cases

- DB migration when `format` column already exists → guard with
  `PRAGMA table_info` or `IF NOT EXISTS`.
- Model sync when registry card has 0 models (`custom` entry) → no rows inserted;
  switch just creates provider row.
- Switching OFF a provider that never had a row → no-op (no insert).
- Theme: localStorage read on SSR → use `typeof window !== 'undefined'`.
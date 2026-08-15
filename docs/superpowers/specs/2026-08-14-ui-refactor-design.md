# UI Refactor & Design System — Design Spec

**Date:** 2026-08-14
**Status:** Approved
**Approach:** Approach A — Tailwind v4 design tokens + hand-built UI kit, zero new dependencies

## Goal

Refactor the entire UniRoute admin UI for a modern, consistent, dark-first developer-tool look (Linear/Vercel-inspired). Eliminate the copy-pasted, inconsistent styling; fix known bugs; standardize all UI text to English; improve accessibility and perceived smoothness. Light and dark modes both supported; dark is the default.

## Non-Goals

- No new runtime dependencies (no Radix, framer-motion, cva, tailwind-merge, shadcn).
- No backend/API behavior changes beyond what the listed bug fixes require.
- No i18n system (English only).
- No new features beyond the small UX affordances listed (toasts, confirms, skeletons).

## 1. Theming — dark-first tokens

Replace `dark:` class noise with semantic CSS variables in `app/app.css`:

- `:root` holds **dark** values; a `.light` class on `<html>` overrides them. Theme hook (`use-theme`) defaults to **dark** (drop system-preference default).
- Token set via `@theme inline`:
  - `--color-background` (page bg)
  - `--color-surface` (cards)
  - `--color-surface-2` (hover/elevated panels)
  - `--color-border`
  - `--color-foreground`
  - `--color-muted` / `--color-muted-foreground`
  - `--color-primary` (blue) / `--color-primary-foreground`
  - `--color-success`, `--color-warning`, `--color-danger`, `--color-info`
  - `--radius` (default), `--shadow-sm`, `--shadow-md`
- Fonts: keep Inter; add `--font-mono` for logs/IDs/code; use `tabular-nums` for stats.
- Focus-visible ring utility: `focus-visible:ring-2 ring-primary/40` consistent across interactive elements.
- Custom scrollbar styling for log/table wrappers.

### Layout refinements

- Sidebar surface slightly darker than content; active nav item = primary-tinted bg + 3px left accent bar; smooth transitions.
- Sticky header with `backdrop-blur` and border; theme toggle retained.
- Subtle page-fade animation on route change (keyed on `<main>`); sidebar slide on mobile.
- `color-scheme` set per mode (already present via `html.dark`; extend to `.light`).

## 2. Component kit — `app/components/ui/`

All typed, accessible (focus-visible rings, `aria-*`, keyboard nav), `transition-colors`, disabled states, consistent sizes/variants. Every component consumes the theme tokens.

1. **Button** — `variant: primary | secondary | ghost | danger | outline`; `size: sm | md | icon`. Native `type` passthrough for React Router `Form`.
2. **Input / Textarea / Select / Checkbox / Label** — one field family; `Label` wired to control via `htmlFor`/`id`; optional `error` state.
3. **Card** (+ `CardHeader`/`CardTitle`) — one surface; padding variants `p-4/5/6`.
4. **Badge** — `tone: neutral | success | warning | danger | info | primary`; `style: solid | subtle`.
5. **Toggle** — accessible `role="switch"` switch; replaces the 3 incompatible toggle idioms.
6. **Tabs** — `role="tablist/tab/tabpanel"`, arrow-key nav, `aria-selected`.
7. **Combobox** (upgrade existing `combobox.tsx`) — `role="listbox/option"`, `aria-activedescendant`, `aria-expanded`.
8. **ConfirmDialog** — native `<dialog>` with backdrop, ESC/cancel, focus management; `useConfirm()` hook wrapping the dialog so destructive actions get confirms with minimal wiring.
9. **CopyButton** — unified clipboard + fallback + success feedback.
10. **Toast system** — `ToastProvider` + `useToast()`; success/error/info toasts for action results (no more silent failures).
11. **Tooltip** — lightweight CSS tooltip for icon-only buttons.
12. **EmptyState** — icon + title + description + optional action.
13. **StatCard** — unified (merges `home` + `api-manager` local variants).
14. **UsageBar / Skeleton / Spinner** — progress bar, loading shimmer, spinner.
15. **PageHeader** — consistent h1 + icon + subtitle + actions.
16. **Table primitives** — `Table/Th/Tr/Td` with `scope="col"`, unified row/border styles, `.table-wrap` wrapper.

### Consolidation of existing component files

- Move/upgrade `combobox.tsx` into the kit.
- `provider-form.tsx`, `provider-templates.tsx`, `stat-card.tsx`, `log-viewer.tsx`, `model-selector.tsx`, `message-input.tsx`, `streaming-response.tsx`, `usage-chart.tsx` all refactored to use the kit. Wire up `LogViewer` (currently unused) into `logs._index`/`logs.proxy` if it fits cleanly; otherwise remove it. Wire up `model-selector` if useful in the playground; otherwise remove.

## 3. Bug fixes (from audit)

1. `providers.$id` delete-provider confirm is a no-op (`onClick` confirm ignored) → use `useConfirm()`.
2. `use-streaming.ts` — Stop leaves UI stuck streaming (AbortError catch returns early without resetting state).
3. `api-manager.$id` — deleted-key screen never renders (revalidated loader throws 404 → ErrorBoundary) → friendly "key deleted" state.
4. `api-manager.create` — double-submit/empty-key submit; guard + toast feedback.
5. `api-manager.$id` — `expires_at` UTC date-shift → use local-time formatting.
6. `logs._index`/`logs.proxy` — `pendingDelete` never cleared on failed delete → clear + error toast.
7. `use-realtime-logs.ts` — no `EventSource.onerror` → disconnect indicator + auto-reconnect.
8. `proxies.tsx` — sync results silently dropped after staging loaded; missing confirmations on delete actions → `useConfirm()`.
9. `api.tsx` — stale Indonesian "moved to API Manager" banner; missing allowlist empty-state; dead code cleanup.
10. Accessibility sweep — `htmlFor`/`id` label association, `aria-label` on icon-only buttons, `role`/`scope` on tabs/tables, `autocomplete` on login password.

## 4. Consistency & language

- All UI text in English (currently mixed Indonesian/English, sometimes same page). `<html lang="en">` already set.
- Unified heading hierarchy via `PageHeader`; single card scheme; single input family; single toggle; single badge family.
- Remove the redundant duplicate status-color maps; centralize in `Badge`.

## 5. Motion & performance

- CSS-only transitions (hover/focus, page fade, sidebar slide, active-press scale). No animation library.
- `tabular-nums` on numeric stats; mono font for IDs/endpoints/logs.
- No new dependencies; bundle stays lean.

## 6. Verification

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- Manual smoke test: theme toggle, provider toggle/test, delete-confirm flows, key create/delete, streaming stop, log clear/delete, proxy sync.
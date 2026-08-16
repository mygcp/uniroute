# Performance & Motion Pass — Design Spec

**Date:** 2026-08-15
**Status:** Approved
**Approach:** Approach A — CSS + View Transitions API + targeted render optimizations, zero new dependencies

## Context for agents (read this first)

This spec describes a **frontend-only performance & motion pass**. The rest of the repo is a working AI-gateway app; do not touch backend logic.

- **Stack:** React 19 + React Router v8 (SSR, `flatRoutes()`), Tailwind CSS v4 (`@import "tailwindcss"` + CSS-variable design tokens in `app/app.css`), `lucide-react` icons. Built with Bun (`bun.lock`), bundled by Vite.
- **Structure:** `app/routes/*.tsx` = pages (data loaders are server-side via `app/.server/*`); `app/components/` = shared components; `app/components/ui/` = hand-built design-system kit (Button, Card, Badge, Tabs, Combobox, Toast, ConfirmDialog, etc.). Everything is typed; `app/routes/+types/` is auto-generated.
- **Hard constraints from earlier specs (do not violate):** **zero new runtime dependencies** (no motion/framer-motion, no virtualization lib); all UI text in English; dark-first theme with a `.light` override on `<html>`; motion must be `transform`/`opacity`-only and respect `prefers-reduced-motion`.
- **Current perf problems already located** (see sections below): SSE log updates re-render the whole list per event; route changes remount the full page via `key={pathname}`; large pages re-render too much on local state changes; Inter font is declared but never loaded.
- **Don't re-explore what's already in this spec** — line numbers are current as of 2026-08-15. If a referenced file changed since, just locate the equivalent code.
- **Verify with:** `npm run typecheck`, `npm test`, `npm run build` (all must pass). No test framework to extend unless the change is pure logic worth a unit test.

## Goal

Make the UniRoute admin UI feel fast and smooth: (1) eliminate the main sources of jank (realtime log streaming, large tables/forms), (2) add cheap CSS-native micro-animations, (3) use the browser View Transitions API for page navigation. Keep the existing "zero new dependencies" principle from the design system spec.

## Non-Goals

- No backend/API/proxy/pipeline behavior changes.
- No new runtime dependencies (no motion/framer-motion, no virtualization library).
- No large refactor of the 1398-line `proxies.tsx` — only targeted memoization of its big sub-components.
- No i18n, no new features.

## 1. Realtime log streaming (main jank source)

Problem: `use-realtime-logs.ts:35` calls `setLogs` per SSE event, and `log-viewer.tsx:65` re-renders all (up to 1000) rows on every state change.

1. **rAF-batched flush** — events accumulate in a buffer; a `requestAnimationFrame` flushes to React state at most once per frame. Cuts React renders drastically during event bursts.
2. **`React.memo` on log rows** — each `Row` becomes memoized with a stable `key` (`id` or `created_at`); only changed rows re-render.
3. **`useDeferredValue` for filters** in `logs._index.tsx` / `logs.proxy.tsx` — search inputs (model/provider/source) stay responsive; results lag by half a frame.
4. **`content-visibility: auto`** on the scroll container — browser skips rendering rows outside the viewport while scrolling fast.
5. Keep the 1000-event state cap; batched + memoized rows make realtime scroll smooth.

## 2. View Transitions for navigation

Replace `key={pathname}` + simple CSS fade in `root.tsx:86` with the native View Transitions API.

1. In `AppShell`, wrap `<Outlet />` in an element with `view-transition-name: page`.
2. A small helper (in `root.tsx` or `entry.client.tsx`) calls `document.startViewTransition()` when `useNavigation().state` transitions to `"loading"`.
3. Fallback: browsers without View Transitions fall back to the existing `.animate-page-in` fade — no broken state.
4. CSS: default transition is a ~150ms opacity cross-fade with a subtle `translateY(6px)` on the entering page.
5. `prefers-reduced-motion` → transitions are instant.
6. View Transitions applies to client-side navigation only; server redirects (login/logout) keep full-page navigation.

## 3. Micro-animations (CSS-native)

All via `transform`/`opacity` only (compositor-friendly, no layout thrash). All disabled under `prefers-reduced-motion`.

1. **Button** (`ui/button.tsx`) — `active:scale-[0.97]` press feedback; widen transition to include `transform`. Add a `Skeleton` shimmer util to `feedback.tsx`.
2. **Mobile sidebar** (`sidebar.tsx:151`) — replace conditional `open ?` render with a persistent container that toggles `translate-x-0` / `-translate-x-full` + backdrop opacity, `transition-transform` ~200ms ease-out.
3. **Toast** (`ui/toast.tsx:37`) — slide-in-right + fade on entry; slide-out-right before removal (schedule removal via timeout, not instant unmount).
4. **Toggle** (`ui/toggle.tsx`) — knob `transition-transform` on switch, not an instant jump.
5. **Combobox dropdown** (`ui/combobox.tsx:87`) — open/close with `scale-y` + `origin-top` fade (~100ms).
6. **Card / stat-card** — `hover:border-primary/30` + `hover:-translate-y-0.5` (transform-only).
7. **Tabs** (`ui/tabs.tsx`) — keep `transition-colors`, add subtle press `scale`.
8. **Dialog** (`ui/confirm-dialog.tsx`) — backdrop fade-in + dialog `scale-95→100` pop-in.

All defined as utility classes / keyframes in `app/app.css` under `animate-*` prefixes.

## 4. Large tables/forms + initial load

1. **Combobox** (`ui/combobox.tsx:29`) — compute filtered + `.slice(0, 20)` in `useMemo`, recalculated only when input changes; memo the dropdown.
2. **`proxies.tsx`** — targeted only: split large components into memoized sub-components (`FreeProxyRow`, table rows) so local setState doesn't re-render the whole page.
3. **Fonts** — `app.css:6` declares Inter but `root.tsx:20` only preconnects; the stylesheet is never loaded. Load Inter with `display=swap` so text renders immediately with fallback and Inter loads in the background (non-blocking).
4. **Route code splitting** — already automatic via React Router (see split chunks in `build/client/assets/`); no change needed. No `React.lazy`.

## 5. Motion & performance principles

- CSS-only transitions; `transform`/`opacity` only; `content-visibility` for long lists.
- All motion respects `prefers-reduced-motion` (instant/disabled).
- No new dependencies; bundle stays lean.

## 6. Verification

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- Manual smoke test: page navigation feels smooth (cross-fade); realtime logs scroll without jank under event bursts; typing in log filters stays responsive; theme toggle, provider toggle/test, delete-confirm flows, streaming stop, log clear/delete, proxy sync, mobile sidebar slide, toast enter/exit, dialog pop-in all smooth.
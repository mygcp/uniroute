# Glass UI Design System Pass — Design Spec

**Date:** 2026-08-16
**Status:** Approved
**Approach:** Subtle glass on near-black — translucent surfaces + backdrop-blur + hairline borders + inner top highlights, keeping the existing Tailwind v4 token architecture and component API.

## Goal

Restyle the entire `app/components/ui/` kit and the app chrome (header, sidebar, login) from the current flat, solid-fill dark look into a cohesive, modern "matte glass" aesthetic — the frosted, translucent feel of macOS / Deepin UI, tuned for a dark-first developer tool. The header's existing `backdrop-blur` treatment is the seed; everything else currently does not match it.

## Non-Goals

- No new runtime dependencies (no Radix, framer-motion, cva, tailwind-merge).
- No change to component APIs, props, variant names, or accessibility behavior.
- No change to backend/API behavior, routes, or page structure.
- No light-theme redesign beyond the glass token values.
- No change to the current blue accent color (`#3b82f6` dark / `#2563eb` light).

## 1. Glass tokens (`app/app.css`)

Add translucent color tokens next to the existing semantic tokens, defined per mode via the existing `:root` (dark) / `.light` override mechanism, and exposed through `@theme inline` so components use Tailwind utilities (`bg-glass`, `bg-glass-strong`, `border-glass-border`).

| Token | Dark | Light |
| --- | --- | --- |
| `--glass` | `rgba(255,255,255,0.03)` | `rgba(255,255,255,0.55)` |
| `--glass-strong` | `rgba(255,255,255,0.05)` | `rgba(255,255,255,0.70)` |
| `--glass-border` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.08)` |
| `--glass-highlight` | `rgba(255,255,255,0.07)` | `rgba(255,255,255,0.70)` |

Expose as `--color-glass`, `--color-glass-strong`, `--color-glass-border`, `--color-glass-highlight` in `@theme inline`.

## 2. The glass recipe

Shared treatment, applied per component with judgment about size:

- Translucent background: `bg-glass` / `bg-glass-strong`.
- `backdrop-blur` only on **larger** surfaces: cards, dialogs, toasts, sidebar, header, inputs, dropdowns. Small elements (badges, icon buttons, tabs, toggles) get tint + hairline border + inner highlight only — blur there is invisible and costly.
- Hairline border: `border-glass-border`.
- Inner top highlight: `shadow-[inset_0_1px_0_var(--glass-highlight)]`.
- Soft outer shadow for depth (keep existing `shadow-sm`/`shadow-lg` usage).
- Preserve all existing focus-visible rings, transitions, disabled states, and active-press scales.

## 3. Ambient background

A near-black flat bg cannot show frost, so add two faint fixed radial glows behind the app so translucent panels read as glass:

- Dark: blue glow top-left, cyan/purple glow bottom-right, ~4–6% opacity (subtle gradient, not a wallpaper).
- Light: faint cool glows on white.
- Implement as fixed, low-opacity gradient layers on `body` (or a fixed pseudo-element) behind the `#root`/`<main>` content; must not affect readability or scroll behavior. Keep tabular/log areas legible.

## 4. Component changes

All in `app/components/ui/` plus app chrome. Variant names, props, and a11y unchanged.

1. **Button** — variants restyled to glass (no solid Bootstrap-style fills):
   - `primary`: `bg-primary/15 text-primary border border-primary/25` + inner highlight; hover `bg-primary/25`.
   - `secondary`: `bg-glass-strong text-foreground border border-glass-border`; hover brightens (`bg-glass`/higher alpha).
   - `ghost`: transparent; hover `bg-glass`.
   - `danger`: `bg-danger/15 text-danger border border-danger/25`; hover `bg-danger/25`.
   - `outline`: `bg-glass border border-glass-border`; hover brightens.
   - Keep rounded-lg, `active:scale-[0.97]`, focus ring `ring-primary/50`, disabled `opacity-50`.

2. **Field** (`Input` / `Textarea` / `Select` / `Checkbox` in `field.tsx`):
   - `bg-glass-strong backdrop-blur-sm border-glass-border`; focus `border-primary/40 ring-primary/20` + inner highlight; invalid state keeps `border-danger` styling but glassy.
   - Checkbox: glassy track (`bg-white/10`), `accent-primary` retained.

3. **Card / StatCard**: `bg-glass backdrop-blur-md` + hairline border + inner highlight + soft shadow; keep hover lift + `hover:border-primary/30`.

4. **Badge**: `subtle` tones → translucent tinted bg + tinted hairline border (e.g. `bg-primary/15 border-primary/25 text-primary`); `solid` kept as the strong style but softened (tinted translucent, not flat fills).

5. **Tabs**: active = glass pill (`bg-glass-strong border-glass-border`); inactive translucent hover.

6. **Toggle**: off-track `bg-white/10`, on-track primary tint; glassy knob.

7. **Combobox dropdown**: `bg-background/80 backdrop-blur-md` + hairline border + inner highlight.

8. **ConfirmDialog**: glassy panel `bg-background/80 backdrop-blur-xl` + hairline border + inner highlight; keep blurred backdrop and `dialog-pop` animation.

9. **Toast**: `bg-background/80 backdrop-blur-md` + hairline border + inner highlight; keep enter/exit animations.

10. **Tooltip**: `bg-surface-2/90 backdrop-blur-sm`.

11. **Table**: `TRow` hover translucent (`hover:bg-glass`); `THead` keeps hairline border; cells unchanged.

12. **Header**: `bg-background/60` + `border-glass-border` + inner highlight (blur already present).

13. **Sidebar**: desktop aside → glass panel `bg-background/70 backdrop-blur-md`; mobile drawer similarly glassy; active nav keeps blue-tinted glass pill (`bg-primary/15`).

14. **Login** (`routes/login.tsx`): glass card over ambient background; glass inputs.

## 5. Light mode

Same recipe with light token values: translucent white panels, `rgba(0,0,0,0.08)` hairline borders, light inner highlights. All mode-specific styling lives in the CSS variables; no hardcoded `dark:`/`light:` utility sprawl in components.

## 6. Motion & performance

- All existing CSS-only transitions kept; no animation library.
- Backdrop-blur used sparingly (only on large surfaces) to keep compositing cheap.
- `prefers-reduced-motion` block already present in `app.css` stays effective.

## 7. Verification

- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- Manual smoke: theme toggle, a provider form (inputs/select/combobox/toggle), a confirm dialog, toasts, table hover, sidebar + header on desktop and mobile, login page.
# Design: API Manager UX Polish

Date: 2026-08-16
Status: Approved

## Summary

Polish the `/api-manager` create/edit key flows:

1. **Button style consistency** — the "+ Create New Key" header action (and its
   neighbors Templates/Groups) are raw `<a>` tags with an outdated solid style,
   so they don't match the app's glass `Button` component.
2. **Model autocomplete with type badges** — `allowed_models` and `blocked_models`
   fields (create + edit) have no suggestions. Replace them with a chip/tag input
   that suggests available models and combos, visually separating
   "model" (provider model) from "combo" (`combo:<name>`).

Max Active Sessions (`quota.concurrent_requests`) and rate limits
(`quota.rpm`/`quota.tpm`) already exist and are enforced — **no changes**.

## 1. Button restyle (`api-manager._index.tsx`)

- Refactor `app/components/ui/button.tsx`: extract the class builder into
  `export function buttonClass(variant, size, extra?)`; `<Button>` uses it
  internally (no visual change).
- In `api-manager._index.tsx` PageHeader actions, replace the three raw `<a>`
  tags with react-router `<Link>` using `buttonClass`:
  - Templates / Groups → `buttonClass("outline", "sm")`
  - Create New Key → `buttonClass("primary", "sm")` — identical to other
    primary buttons (glass fill, inset highlight, focus ring, active scale).
- No other pages touched.

## 2. Server-side suggestions (`app/.server/suggest.ts`)

Keep `getModelSuggestions()` and `getProviderSuggestions()` unchanged (still used
by `model_override` / `pinned_provider_id`).

Add `getStructuredSuggestions()` returning:

```ts
type TagSuggestion =
  | { value: string; type: "model"; provider?: string }
  | { value: string; type: "combo" };
```

- **Models**: query `models` (active) for `model_name` + `provider_id`, plus
  names from `model_allowlist`, `routing_rules`, and existing keys (provider
  unknown → omitted). Dedup by model name; prefer an active provider when a name
  appears multiple times.
- **Combos**: `listCombos().map(c => ({ value: `combo:${c.name}`, type: "combo" }))`.
- Sort models A→Z, then combos A→Z.

## 3. New `TagInput` component (`app/components/ui/tag-input.tsx`)

- Props: `options: TagSuggestion[]`, `value: string` (comma-separated),
  `onChange(v: string)`, `id?`, `placeholder?`, `className?`, `name?`.
- Renders a bordered container matching the existing `Input` (`bg-glass-strong`,
  glass border, inset highlight).
- **Chips**: one removable chip per parsed value (deduped, `combo:` prefix kept
  verbatim). Backspace deletes the last chip when the input is empty;
  Enter/comma commit the typed text as a chip.
- **Dropdown** (reuses the glass listbox styling from `ui/combobox.tsx`):
  filters options by query, keyboard nav (arrows/enter/escape), click-to-add.
  Each row:
  - model → name + provider in muted text + small "model" badge
  - combo → `combo:<name>` + a "combo" badge
- Already-added chips are hidden from the dropdown.
- Accessibility: `role="combobox"/"listbox"/"option"`, `aria-expanded`,
  `aria-activedescendant`.

## 4. Form integration (create + edit)

- `api-manager.create.tsx`: load `getStructuredSuggestions()` in the loader;
  replace `allowed_models` and `blocked_models` `<Textarea>`s with `<TagInput>`.
  A hidden input keeps the comma-separated value, so `parseList()` in the action
  is untouched. Template application (`applyTemplate`) still works — it sets the
  same field name.
- `api-manager.$id.tsx`: add `getStructuredSuggestions()` to the loader, pass
  into `EditKeyForm`, swap the same two Textareas (prefilled from
  `data.allowed_models` / `data.blocked_models`).
- No backend/action changes.

## File Changes

- `app/components/ui/button.tsx` — export `buttonClass`; `Button` uses it.
- `app/routes/api-manager._index.tsx` — header actions use `Link` + `buttonClass`.
- `app/.server/suggest.ts` — add `getStructuredSuggestions` + `TagSuggestion`.
- `app/components/ui/tag-input.tsx` — new.
- `app/routes/api-manager.create.tsx` — loader + TagInput for allow/block models.
- `app/routes/api-manager.$id.tsx` — loader + TagInput for allow/block models.

## Testing

- `app/.server/suggest.test.ts` — extend: structured suggestions include active
  models with providers, allowlist/keys names, and combos as `combo:<name>` with
  correct types; dedup works.
- `app/components/ui/tag-input.test.tsx` — new: chips render; typing + Enter adds
  a chip; backspace removes; dropdown filters; selecting a combo inserts
  `combo:<name>`.
- `npm run build` + `npm test` pass.

## Non-Goals

- No backend changes to key creation/update or rate-limit enforcement.
- No changes to `model_override` / `pinned_provider_id` fields.
- No changes to pages other than `/api-manager` header actions and the
  create/edit key forms.
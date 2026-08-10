# Desain: Detail UX Halaman API Management

Tanggal: 2026-08-10
Status: Approved

## Ringkasan

Perbaikan detail kecil UX pada halaman `/api` (`app/routes/api.tsx`):

1. **Suggestion auto-fill** (combobox) pada form yang mengetik nama model/provider
   yang datanya sudah ada di DB.
2. **Penjelasan form Routing Rules** — apa fungsinya dan arti tiap field/tipe.
3. Field target bersifat kondisional mengikuti tipe rule.

Bahasa _UI text_ (helper, label, placeholder): **Inggris**, konsisten dengan arah UI
di masa depan.

## 1. Komponen `Combobox`

File baru `app/components/combobox.tsx` — input teks bebas dengan dropdown sugesti.

- Props: `options: string[]`, `value: string`, `onChange: (v: string) => void`,
  `name?: string`, `placeholder?: string`.
- Perilaku:
  - Filter case-insensitive substring dari `options` saat mengetik.
  - Navigasi keyboard: ↑/↓ gerakkan pilihan, Enter pilih, Escape tutup.
  - Klik item memilih; blur/tutup ketika klik di luar.
  - **Free text tetap diperbolehkan** (pengguna boleh mengetik model baru).
  - Merender `<input name={name} ...>` sehingga bekerja langsung dengan
    `<Form method="post">` yang sudah dipakai di halaman, tanpa submit manual.

Styling mengikuti `inputClass()` (border gray, rounded-lg, dark mode) yang sudah ada.

## 2. Data sugesti di loader

Loader `api.tsx` menambahkan dua daftar:

- `modelSuggestions`: UNION dedup dari:
  - `models.model_name` di mana `is_active = 1`
  - `model_allowlist.model_name`
  - `routing_rules.source_model` dan `routing_rules.target_model`
  - `client_api_keys.allowed_models` dan `client_api_keys.model_override`
  Diurutkan alfabetis.
- `providerSuggestions`: `SELECT id FROM providers ORDER BY id`.

## 3. Penerapan combobox

| Form | Field | Options |
|---|---|---|
| Model Allowlist | `model_name` | `modelSuggestions` |
| Routing Rules | `source_model` | `modelSuggestions` |
| Routing Rules | `target_model` | `modelSuggestions` |
| Routing Rules | `target_provider_id` | `providerSuggestions` |
| EditKeyForm | `model_override` | `modelSuggestions` |
| EditKeyForm | `pinned_provider_id` | `providerSuggestions` |
| EditKeyForm | `allowed_models` (textarea) | — dibiarkan apa adanya |

## 4. Penjelasan Routing Rules

- Subtitle di kartu "Routing Rules" menjelaskan fungsi: rules dievaluasi per request
  berdasarkan `source_model`, diproses urut `priority`.

- Keterangan singkat tiap tipe pada opsi `rule_type`:
  - `rewrite` — replace the requested model with `target_model`
  - `deny` — block the model
  - `fallback` — reroute to `target_provider` when the primary route fails

- Field `target_model` ditampilkan hanya untuk tipe `rewrite`; `target_provider_id`
  hanya untuk tipe `fallback` (mengikuti pilihan `rule_type`).

- Placeholder/label diperjelas, mis. placeholder "e.g. gpt-4o" dan
  "e.g. openai" untuk target provider.

## Perubahan File

- `app/components/combobox.tsx` — baru.
- `app/routes/api.tsx` — loader + pemakaian combobox + teks bantu Routing Rules.

## Non-Goals

- Tidak mengubah perilaku routing/evaluasi rules di sisi server.
- Tidak mengubah Allowed models textarea di EditKeyForm.
- Tidak melakukan automatic submit saat memilih sugesti.
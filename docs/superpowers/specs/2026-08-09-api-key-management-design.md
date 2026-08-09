# Desain: Client API Key Management

Tanggal: 2026-08-09
Status: Approved

## Ringkasan

Menambahkan dukungan **client API keys** pada gateway `/v1/chat/completions` sehingga
setiap key dapat memiliki aturannya sendiri (beda key → beda rule). Key bersifat
opsional dengan switch master "Wajib API key" untuk memaksa autentikasi.

## Latar Belakang

Saat ini gateway `/v1/chat/completions` tidak memiliki autentikasi — siapa pun yang
memanggil endpoint dapat mengakses model apa pun. `routing_rules` dan
`model_allowlist` bersifat global, berlaku sama untuk semua klien. `provider_credentials`
adalah key *outbound* (untuk memanggil upstream) dan tidak berhubungan dengan klien.

## Tujuan

- Klien dapat dibuatkan key khusus dengan aturan sendiri.
- Setiap key dapat: membatasi model yang boleh dipanggil, memaksa model tertentu,
  dan/atau memaksa penggunaan provider tertentu.
- Key tidak disimpan dalam plaintext.
- Tidak ada perubahan pada perilaku default (tanpa key tetap jalan) kecuali switch
  master "Wajib API key" diaktifkan.

## Data Model

### Tabel baru `client_api_keys`

```sql
CREATE TABLE IF NOT EXISTS client_api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  key_hash TEXT UNIQUE NOT NULL,     -- SHA-256 hex dari key mentah
  key_prefix TEXT NOT NULL,          -- 8 karakter pertama key untuk tampilan
  allowed_models TEXT,               -- JSON array, NULL/kosong = semua model
  model_override TEXT,               -- NULL = normal; string = paksa semua ke model ini
  pinned_provider_id TEXT,           -- NULL = routing normal; string = paksa provider ini
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER DEFAULT (unixepoch())
);
```

### Tabel baru `settings` (key-value)

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
```

Kunci `require_api_key` (`'1'`/`'0'`) mengontrol apakah request tanpa key ditolak 401.

## Alur Validasi di `/v1/chat/completions`

1. Baca header `Authorization: Bearer <token>`.
2. Jika token ada:
   - Hitung SHA-256, cari di `client_api_keys`.
   - Tidak ketemu atau `is_active = 0` → `401 { error: "invalid api key" }`.
   - `allowed_models` (JSON array) → cocokkan model diminta dengan prefix. Tidak ada
     yang cocok → `403 { error: "model not allowed" }`.
   - `model_override` → ganti `body.model` sebelum global rules (rewrite dari
     `routing_rules` tetap bisa menimpa setelahnya).
   - `pinned_provider_id` → simpan sebagai kandidat provider prioritas tertinggi saat
     pemilihan provider.
3. Jika token tidak ada:
   - `require_api_key` = `'1'` → `401 { error: "api key required" }`.
   - selain itu → lanjut seperti perilaku saat ini (global rules).

## Integrasi Routing

- `pinned_provider_id` diimplementasikan dengan memastikan provider tersebut menjadi
  kandidat pertama di `orderCandidates` (di atas fallbackId), tanpa mengubah logika
  global.
- Header `Authorization` dari klien tidak diteruskan ke upstream; header outbound
  tetap dibangun dari `getApiKey(provider.id)` seperti sekarang.

## UI — Tab "API Keys" di Halaman `/api`

- Tab baru "API Keys" di samping "Model Allowlist" dan "Routing Rules".
- Form tambah: field Label, tombol *Generate* untuk membuat `sk-` diikuti random
  (40 hex). Key ditampilkan sekaligus saat submit (banner kuning) dan tidak tersimpan
  plaintext.
- Daftar key: nama, `key_prefix…`, toggle aktif, tombol edit rules, tombol hapus.
- Form edit rules per key: `allowed_models` (textarea, satu per baris), `model_override`,
  `pinned_provider_id`.
- Switch master "Wajib API key" di atas daftar, menulis ke tabel `settings`.

## Keamanan

- Hanya SHA-256 hash yang disimpan; key mentah tidak pernah ditulis ke DB.
- Key ditampilkan utuh satu kali tepat setelah pembuatan.
- Perbandingan hash menggunakan lookup SQL langsung (tidak ada iterasi brute force).

## Testing

Unit test (`client-key.test.ts`) mencakup:
- validasi key valid / invalid / inactive
- pencocokan `allowed_models` (match prefix, mismatch)
- `model_override` diterapkan
- switch master `require_api_key` memblokir request tanpa key
- hash key tidak pernah bocor ke output / DB

## Lingkup di Luar Fase Ini

- Rate limit & kuota per key.
- Audit log akses per key.
- Multiple klien per key / token rotating.

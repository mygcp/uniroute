# Fase 1 — Setup & Scaffold

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development or executing-plans. Steps use checkbox syntax.

**Tujuan:** Membuat proyek React Router v8 (Framework Mode) + Bun + SQLite + Tailwind dari nol, plus schema database lengkap (8 tabel) dengan seed data. Fase ini menjadi fondasi semua fase berikutnya.

**Deliverable:** `bun run dev` boot tanpa error, DB terinisialisasi dengan 8 tabel + seed, struktur `app/` per PRD §8 siap diisi.

**Sumber:** PRD §4 (schema), §5 (env), §8 (file structure), §15 (technical notes).

---

## Task 1.1 — Inisialisasi proyek Bun + React Router v8

**Files:**
- Create: `package.json`, `tsconfig.json`, `bun.lock`, `.gitignore`, `vite.config.ts`, `react-router.config.ts`
- Create: `app/root.tsx` (minimal), `app/entry.server.ts`, `app/entry.client.tsx` (framework mode entry)

- [x] **Step 1: Inisialisasi direktori minimal**

```bash
cd /home/adieu/projects/uniroute
mkdir -p app data bin
printf '{"name":"uniroute","version":"0.1.0","type":"module"}\n' > package.json
```

- [x] **Step 2: Install dependensi core**

```bash
bun add react react-dom react-router
bun add -d @react-router/dev @react-router/fs-routes vite @vitejs/plugin-react typescript @types/react @types/react-dom
```

> Catatan: PRD §15 — pakai `react-router` (bukan `react-router-dom`); DOM-specific dari `react-router/dom`.

- [x] **Step 3: Konfigurasi Vite (`vite.config.ts`)**

```ts
import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
});
```

- [x] **Step 4: Konfigurasi React Router (`react-router.config.ts`)**

```ts
import { type Config } from "@react-router/dev/config";

export default {
  ssr: true,
} satisfies Config;
```

> Catatan: file-route `flatRoutes()` otomatis di-discover dari `app/routes/` pada React Router v8 — tidak perlu setup tambahan di config ini.

- [x] **Step 5: File entry minimal**
  - `app/entry.server.ts`: render `handleRequest` standar React Router v8.
  - `app/entry.client.tsx`: `hydrateRoot` standar.
  - `app/root.tsx`: `export function Layout({ children }) { return <html><body>{children}</body></html> }` + `export default function Root()` dengan `<Outlet />`.

- [x] **Step 6: Verifikasi boot**

```bash
bun run dev
```

Expected: server jalan di `http://localhost:3000` tanpa error compile.

---

## Task 1.2 — Environment Variables

**Files:**
- Create: `.env`, `.env.example`

- [x] **Step 1: Tulis file env dengan 4 variabel**

```env
PORT=3000
BASE_URL=http://localhost:3000
PASSWORD=CHANGEME
DATABASE_URL=./data/uniroute.db
```

- [x] **Step 2: Buat `.env.example` (tanpa nilai rahasia nyata), dan tambahkan `.env` ke `.gitignore`**

```
data/
.env
node_modules/
build/
```

- [x] **Step 3: Verifikasi env dibaca**

```bash
bun -e "console.log(process.env.PORT, process.env.BASE_URL, process.env.PASSWORD, process.env.DATABASE_URL)"
```

Expected: 4 nilai tercetak sesuai `.env`.

---

## Task 1.3 — Database schema + seed (SQLite)

**Files:**
- Create: `app/.server/db.ts`
- Create: `app/.server/seed.ts` (opsional, dipanggil dari `db.ts` saat inisialisasi)

- [x] **Step 1: Buat client `bun:sqlite` singleton di `app/.server/db.ts`**

```ts
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const dbPath = process.env.DATABASE_URL ?? "./data/uniroute.db";
mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");
```

- [x] **Step 2: Jalankan schema (8 tabel) dari PRD §4 persis**

```sql
CREATE TABLE IF NOT EXISTS providers ( ... );        -- §4
CREATE TABLE IF NOT EXISTS models ( ... );            -- §4
CREATE TABLE IF NOT EXISTS model_allowlist ( ... );   -- §4
CREATE TABLE IF NOT EXISTS routing_rules ( ... );     -- §4
CREATE TABLE IF NOT EXISTS load_balancing ( ... );    -- §4
CREATE TABLE IF NOT EXISTS compression_settings ( ... ); -- §4 (id=1 CHECK)
CREATE TABLE IF NOT EXISTS request_logs ( ... );      -- §4
CREATE TABLE IF NOT EXISTS proxy_logs ( ... );        -- §4
```

> Copy identik definisi kolom dari PRD §4 (termasuk `UNIQUE`, `DEFAULT`, `CHECK`).

- [x] **Step 3: Seed data minimal (hanya jalankan jika tabel kosong)**

Provider: `openai`, `anthropic`, `google`, `groq`, `openrouter`, `mistral`, `cohere`, `deepseek` (+1 free provider).

```sql
INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
VALUES
  ('openai',     'OpenAI',     'https://api.openai.com',  'bearer', 1, 3, 2),
  ('anthropic',  'Anthropic',  'https://api.anthropic.com','bearer', 1, 1, 1),
  ('google',     'Google',     'https://generativelanguage.googleapis.com', 'apikey', 1, 1, 0),
  ('groq',       'Groq',       'https://api.groq.com',   'bearer', 1, 1, 1),
  ('openrouter', 'OpenRouter', 'https://openrouter.ai',  'bearer', 1, 2, 0),
  ('mistral',    'Mistral',    'https://api.mistral.ai', 'bearer', 1, 1, 0),
  ('cohere',     'Cohere',     'https://api.cohere.ai',  'bearer', 1, 1, 0),
  ('deepseek',   'DeepSeek',   'https://api.deepseek.com','bearer', 1, 1, 0);
```

Seed `models` contoh (untuk demo load balancing multi-provider):

```sql
INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary)
VALUES
  ('gpt-4o',  'openai',     128000, 1, 1),
  ('gpt-4o',  'groq',       128000, 1, 0),
  ('gpt-4o',  'openrouter', 128000, 1, 0),
  ('claude-3-5-sonnet', 'anthropic', 200000, 1, 1),
  ('gemini-1.5-pro',     'google',    1000000, 1, 1),
  ('llama-3.1-8b',       'groq',       131072, 1, 1),
  ('mistral-large',      'mistral',    128000, 1, 1);
```

Seed minimal untuk tabel lain: `compression_settings (id=1, defaults)`, `load_balancing` untuk `gpt-4o` (strategy `round_robin`), `model_allowlist` contoh (mis. deny `nonexistent-model`).

- [x] **Step 4: Verifikasi DB**

```bash
bun -e "await import('./app/.server/db.ts').then(() => console.log('ok'))"
```

Lalu jalankan query:

```bash
bun -e "const{db}=await import('./app/.server/db.ts'); console.log(db.query('SELECT name FROM sqlite_master WHERE type=\'table\'').all())"
```

Expected: 8 tabel terdaftar. Check jumlah baris seed.

---

## Task 1.4 — Struktur folder + routes + global styles

**Files:**
- Create: struktur `app/routes/`, `app/components/`, `app/hooks/`, `app/entry.*`
- Create: `app/routes/_index.tsx` (redirect → `/home`)
- Create: `app/routes/login.tsx` (placeholder, public)
- Create: `app/styles/global.css` (Tailwind)

- [x] **Step 1: Buat placeholder route `_index.tsx`**

```tsx
import { redirect } from "react-router";
import type { Route } from "./+types/_index";

export function loader() {
  return redirect("/home");
}

export default function Index() {
  return null;
}
```

- [x] **Step 2: Buat placeholder route lain (isolasi compile)**

`app/routes/home.tsx` (HTML statis sementara), `.tsx` untuk `/providers`, `/compression`, `/api`, `/combo`, `/proxy`, `logs.tsx`.

- [x] **Step 3: Tailwind CSS**

```bash
bun add -d tailwindcss @tailwindcss/vite
```

`app/styles/global.css`:

```css
@import "tailwindcss";
```

Import `global.css` di `app/root.tsx`.

- [x] **Step 4: Verifikasi**

```bash
bun run dev        # boot OK
bun run build      # build tanpa error
```

Check: `/` redirect ke `/home`; `/login` render placeholder.

---

## Checkpoint Fase 1

- [x] Server boot tanpa error (`bun run dev`).
- [x] 8 tabel seeded di `data/uniroute.db`.
- [x] Struktur `app/.server`, `app/routes`, `app/components`, `app/hooks` ada.
- [x] `/` redirect ke `/home`.
- [x] Commit: `feat: scaffold uniroute with RR8 + bun + sqlite schema`

---

## Catatan Deviasi (disetujui user)

- **SQLite driver:** memakai `node:sqlite` (bukan `bun:sqlite`) karena dev server React Router v8 (Vite SSR) mengeksekusi modul server lewat Node ESM loader yang tidak bisa resolve skema `bun:`. `node:sqlite` berjalan di Node (dev) dan Bun (prod) — disetujui user.
- **Production server:** `build/server/index.js` hanya manifest (tidak listen). Tambah `server.ts` (Bun.serve + `createRequestHandler` + static dari `build/client`) dan script `start: "bun server.ts"`.
- **Entry API:** `entry.server.tsx` memakai `renderToReadableStream` (bukan `renderToPipeableStream`) karena `react-dom/server.bun` tidak mengekspor versi pipeable.
- **Tailwind:** tetap via `app/app.css` (sudah `@import "tailwindcss"`), tidak buat `app/styles/global.css` duplikat.
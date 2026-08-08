# Fase 4 — Auth & Global Layout

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development atau executing-plans. Steps use checkbox syntax.

**Tujuan:** Menerapkan autentikasi password-only (PRD §6.4) dan melindungi **100% route UI**. Halaman `/home` dan seterusnya dirender hanya jika cookie `uniroute_session` valid; selain itu redirect ke `/login`. Membangun root layout global dengan sidebar (PRD §7).

**Deliverable:** Login page, logout, cookie session httpOnly, middleware protect semua route UI, sidebar layout.

**Sumber:** PRD §6 (routing & auth), §7 (sidebar).

---

## Task 4.1 — Auth server

**Files:**
- Create: `app/.server/auth.ts`

**Interfaces:**
- Produces: `createSession(): string` (return token), `setSessionCookie(response: Response, token: string): void`, `verifySessionCookie(request: Request): Promise<boolean>`, `destroySessionCookie(response: Response): void`, `const SESSION_COOKIE`.

- [x] **Step 1: Buat token + store session in-memory**

```ts
const sessions = new Set<string>();
const SESSION_NAME = "uniroute_session";
const SESSION_MAX_AGE = 60 * 60 * 24; // 24 jam

export function createSession(): string {
  const token = crypto.randomUUID();
  sessions.add(token);
  return token;
}
export function isValid(token: string | undefined | null): boolean {
  return !!token && sessions.has(token);
}
export function destroySession(token: string) { sessions.delete(token); }
```

> Session in-memory memenuhi kebutuhan single-instance. (Skala multi-instance memerlukan store shared — di luar scope fase ini.)

- [x] **Step 2: Set cookie helper**

```ts
export function setSessionCookie(response: Response, token: string) {
  response.headers.set("Set-Cookie",
    `${SESSION_NAME}=${token}; Path=/; HttpOnly; Max-Age=${SESSION_MAX_AGE}${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
}
export function clearSessionCookie(response: Response) {
  response.headers.set("Set-Cookie", `${SESSION_NAME}=; Path=/; HttpOnly; Max-Age=0`);
}
export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  const match = cookie?.match(/(?:^|;\s*)uniroute_session=([^;]+)/);
  return match ? match[1] : null;
}
```

- [x] **Step 3: Password verify constant-time (env `PASSWORD`)**

```ts
export function verifyPassword(input: string): boolean {
  const pwd = process.env.PASSWORD;
  if (!pwd) throw new Error("PASSWORD not set");
  const a = new TextEncoder().encode(input);
  const b = new TextEncoder().encode(pwd);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
```

- [x] **Step 4: TDD test `auth.test.ts`**

- `createSession` → token; `isValid(token)` true; setelah `destroy` false.
- `verifyPassword("CHANGEME")` true saat PASSWORD=CHANGEME; salah → false.
- Cookie set benar (HttpOnly, Path).

---

## Task 4.2 — Login page + action

**Files:**
- Modify: `app/routes/login.tsx`
- Create: `app/components/login-form.tsx` (opsional, form password)

- [x] **Step 1: Route `login.tsx` — public only**

Route ini TIDAK dilindungi. `loader` render langsung (tidak redirect).

- [x] **Step 2: Action - handle POST password**

```tsx
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  if (!verifyPassword(password)) {
    return { error: "Password salah" };
  }
  const token = createSession();
  const response = redirect("/home");
  setSessionCookie(response, token);
  return response;
}
```

- [x] **Step 3: UI form**

Input password (type=password) + tombol Login + text error server-rendered. Style Tailwind sederhana (centered card).

- [x] **Step 4: TDD / manual verifikasi**

```bash
curl -c cookies.txt -X POST http://localhost:3000/login \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "password=CHANGEME" -v
```

Expected: HTTP 302 ke `/home` + `Set-Cookie: uniroute_session=...`.

```bash
curl -X POST ... --data "password=salah" 
```

Expected: 200 dengan text error "Password salah" (tanpa cookie).

---

## Task 4.3 — Root guard / middleware

**Files:**
- Modify: `app/root.tsx`

- [x] **Step 1: Tambah `loader` di root — validasi session**

```ts
export async function loader({ request }: Route.LoaderArgs) {
  const token = getSessionToken(request);
  if (!isValid(token)) {
    return redirect(`/login?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  }
  return {};
}
```

> Root layout `loader` otomatis dijalankan untuk semua route child (semua halaman UI) kecuali yang punya `loader` sendiri di parent `login` (public). Karena `/login` berada di luar root guard slot? Periksa struktur route — kabar v8: root.tsx covers semua; pastikan `/login` TIDAK diblok.

**Pembahasan routing:** Dengan `flatRoutes()`, `/login` menjadi child dari root. Agar login public sementara /home protected, gunakan per-route guard:

- Pendekatan A: root loader mengecualikan `request.url` berisi `"/login"` (skip guard).
- Pendekatan B (lebih bersih): pindahkan `/login` ke route terpisah di luar root layout (tidak pakai Layout component). Koreksi `root.tsx` layout hanya untuk protected, dan `.login.tsx` full page sendiri.

> **Rekomendasi B:** gunakan route-level approach: `login.tsx` tidak memakai sidebar `Layout`. Bila flatRoutes tidak mendukung easy-exclude, gunakan `routes.ts` manual: `route("/", "root.tsx")` nested + `route("login", "routes/login.tsx")` di luar.

- [x] **Step 2: Layout publik vs protected**

Root layout memakai sidebar + guard (protected). Route login berdiri sendiri (hanya form, no sidebar).

- [x] **Step 3: Logout**

Di sidebar, link/action POST ke `/_logout` resource → hapus session + clear cookie → redirect `/login`. Tambah resource route `_logout.tsx` dengan `action`.

- [x] **Step 4: Verifikasi manual**

- Akses `/home`, `/providers`, dst tanpa cookie → redirect `/login`.
- Login sukses → akses semua route.
- Cookie httpOnly di browser (tidak bisa JS read).
- Click `/logout` → cookie clear, redirect login.

---

## Task 4.4 — Sidebar + global layout

**Files:**
- Modify: `app/root.tsx`
- Create: `app/components/sidebar.tsx`

- [x] **Step 1: Buat sidebar komponen**

List navigasi dengan NavLink (`react-router`):

```
🏠 Home            → /home
🔌 Provider        → /providers
🗜️ Compression     → /compression
🔑 API             → /api
🔗 Combo           → /combo
🌐 Proxy           → /proxy
📋 Logs            → /logs        (anak: Request Logs, Proxy Logs)
🚪 Logout          → POST /logout
```

Styling Tailwind: fixed sidebar kiri (w-64), item aktif highlight, submenu logs (nested NavLink).

- [x] **Step 2: Root layout render layout**

```tsx
export default function Root() {
  return (
    <div className="flex min-h-screen">
      <Sidebar />
      <main className="flex-1 p-6 bg-gray-50">
        <Outlet />
      </main>
    </div>
  );
}
```

- [x] **Step 3: placeholder halaman protected lain (sudah dibuat placeholder Fase 1) isi minimal "Coming"** — hanya untuk memastikan navbar link tidak 404.

- [x] **Step 4: TDD manual stitch**

Proxy:
```
/home  (protected, render)
/login (public, no sidebar)
```

---

## Checkpoint Fase 4

- [x] Semua route (kecuali `/login`) → redirect `/login` saat tidak punya cookie.
- [x] Login benar → cookie session HttpOnly, umur 24 jam → masuk.
- [x] Password salah → error.
- [x] Logout → cookie clear + redirect `/login`.
- [x] Sidebar lengkap 7 menu + submenu Logs + semua route tidak 404.
- [x] Commit: `feat: auth guard + sidebar layout`
---

## Catatan Deviasi

- **Route logout:** file `_logout.tsx` dihindari karena nama ber-`_` (tanpa dot) di `flatRoutes` jadi pathless route (404). Dipakai `logout.tsx` → path `/logout` (sesuai menu "POST /logout") dengan `loader` redirect & POST `action`.
- **Guard:** pendekatan A (root loader) — skip `/login` dan `/v1/*`, redirect protected → `/login?next=...`. `useLocation` di root untuk menampilkan sidebar hanya di halaman protected.

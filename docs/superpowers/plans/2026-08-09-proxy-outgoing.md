# Outgoing HTTP/SOCKS5 Proxy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Menambahkan proxy keluar (HTTP CONNECT & SOCKS5) untuk semua request UniRoute ke provider (chat, test koneksi, fetch modelsUrl), dengan bulk import (text per baris & JSON) dan bulk assignment (pool per provider), plus proxy per API key.

**Architecture:** Transport di-encapsulate di `fetchUpstream()` (satu titik keluaran) pada modul baru `app/.server/proxy-resolver.ts`. Hiérarchi pemilihan proxy: API key (credential routing) > pool provider > direct. `executor.ts` menerima daftar proxy hasil resolusi dan melakukan failover antar proxy sebelum menyerah; tanpa proxy aktif request tetap direct seperti sekarang. UI `/proxies` dengan tiga tab: Daftar Proxy, Bulk Import, dan Bulk Assignment.

**Tech Stack:** Bun (runtime + `bun test`), `bun:sqlite`/`node:sqlite` via `query()` di `app/.server/db.ts`, React Router (React 19), Tailwind v4, lucide-react, `fetch` native Bun (opsi `proxy`/`socks`), tanpa dependency baru.

## Global Constraints

- Runtime hanya **Bun** (`bun server.ts`, `bun test`); larangan menambah dependency baru ke `package.json`.
- Semua request keluar lewat proxy **hanya** saat proxy aktif & ter-resolve; tanpa proxy aktif → tetap **direct** (perilaku sekarang tidak berubah).
- Prioritas resolusi proxy: **API key (credential) > pool provider > direct**.
- Rotasi pool **round-robin** berdasar `last_used_at` (pola `balancer.ts`), failover antar proxy pada connect error / status retryable.
- Proxy auth failure (status 401/407) **tidak** retryable / tidak failover.
- Akses DB hanya lewat `query()` dari `app/.server/db.ts`; jangan inisialisasi koneksi lain.
- Test baru mengikuti pola: file `*.test.ts` di `app/.server/`, `import "./test-env"` (DATABASE_URL temp), pakai `bun:test`. Regresi penuh = `npm test`, `npm run typecheck`, `npm run build`.
- Tiap task diakhiri commit kecil (`git commit -m "feat: ..."`), hanya file yang relevan.
- Antarmuka `executeStreaming(options)` langsung (tanpa `proxies`) tidak berubah bagi caller lain.

---

### Task 1: Skema DB + migrasi + CRUD proxy

**Files:**
- Modify: `app/.server/db.ts` (tambah `CREATE TABLE` `proxies` & `provider_proxies`, migrasi `provider_credentials.proxy_id`)
- Create: `app/.server/proxy-resolver.ts` (fungsi CRUD saja dulu)
- Test: `app/.server/proxy-resolver.test.ts`

**Interfaces:**
- Produces (dipakai task lain):
  - `type ProxyProtocol = "http" | "socks5"`
  - `type ProxyRow = { id: number; protocol: ProxyProtocol; host: string; port: number; username: string | null; password: string | null; is_active: number; last_used_at: number; created_at: number }`
  - `type ProxyConfig = { id: number; protocol: ProxyProtocol; host: string; port: number; username: string | null; password: string | null }`
  - `type ProxyInput = { protocol: ProxyProtocol; host: string; port: number; username: string | null; password: string | null }`
  - `listProxies(): ProxyRow[]`
  - `getProxy(id: number): ProxyRow | undefined`
  - `upsertProxy(input: ProxyInput): { id: number; inserted: boolean }`
  - `updateProxy(id: number, fields: ProxyInput): void`
  - `setProxyActive(id: number, active: boolean): void`
  - `deleteProxy(id: number): void`
  - `assignProxies(providerId: string, proxyIds: number[]): void`
  - `removeProxyAssignment(providerId: string, proxyId: number): void`
  - `type AssignmentRow = { provider_id: string; provider_name: string; proxy_id: number; protocol: ProxyProtocol; host: string; port: number }`
  - `listAssignments(): AssignmentRow[]`

- [ ] **Step 1: Tulis test yang gagal**

Create `app/.server/proxy-resolver.test.ts`:

```ts
import "./test-env";
import { describe, expect, test } from "bun:test";
import {
  assignProxies,
  deleteProxy,
  getProxy,
  listAssignments,
  listProxies,
  removeProxyAssignment,
  setProxyActive,
  updateProxy,
  upsertProxy,
} from "./proxy-resolver";
import { query } from "./db";

describe("proxy CRUD", () => {
  test("tables & proxy_id column exist", () => {
    const tables = (query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("proxies");
    expect(tables).toContain("provider_proxies");
    const cols = (query("PRAGMA table_info(provider_credentials)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("proxy_id");
  });

  test("upsertProxy inserts and returns id", () => {
    const { id, inserted } = upsertProxy({ protocol: "http", host: "1.2.3.4", port: 8080, username: null, password: null });
    expect(inserted).toBe(true);
    expect(getProxy(id)?.host).toBe("1.2.3.4");
  });

  test("upsertProxy is idempotent on duplicate (host/port/protocol)", () => {
    const first = upsertProxy({ protocol: "socks5", host: "proxy.local", port: 1080, username: "u", password: "p" });
    const second = upsertProxy({ protocol: "socks5", host: "proxy.local", port: 1080, username: "u", password: "p" });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
  });

  test("updateProxy and setProxyActive mutate row", () => {
    const { id } = upsertProxy({ protocol: "http", host: "a.example", port: 80, username: null, password: null });
    updateProxy(id, { protocol: "http", host: "b.example", port: 81, username: "x", password: "y" });
    const row = getProxy(id)!;
    expect(row.host).toBe("b.example");
    expect(row.port).toBe(81);
    setProxyActive(id, false);
    expect(getProxy(id)!.is_active).toBe(0);
  });

  test("deleteProxy removes row and clears credentials + assignments", () => {
    const { id } = upsertProxy({ protocol: "http", host: "c.example", port: 82, username: null, password: null });
    assignProxies("openai", [id]);
    query("INSERT INTO provider_credentials (provider_id, label, api_key, is_active, is_routing, proxy_id, updated_at) VALUES ('openai', 't', 'k', 1, 1, ?, unixepoch())").run(id);
    deleteProxy(id);
    expect(getProxy(id)).toBeUndefined();
    const cred = query("SELECT proxy_id FROM provider_credentials WHERE api_key = 'k'").get() as { proxy_id: number | null };
    expect(cred.proxy_id).toBeNull();
    const assignments = query("SELECT COUNT(*) AS c FROM provider_proxies WHERE proxy_id = ?").get(id) as { c: number };
    expect(assignments.c).toBe(0);
  });
});

describe("provider_proxies assignments", () => {
  test("assign & remove proxy from provider", () => {
    const { id: p1 } = upsertProxy({ protocol: "http", host: "d.example", port: 83, username: null, password: null });
    const { id: p2 } = upsertProxy({ protocol: "http", host: "e.example", port: 84, username: null, password: null });
    assignProxies("deepseek", [p1, p2]);
    assignProxies("deepseek", [p1]); // idempotent
    expect(listAssignments().filter((a) => a.provider_id === "deepseek").length).toBe(2);
    removeProxyAssignment("deepseek", p1);
    const remaining = listAssignments().filter((a) => a.provider_id === "deepseek").map((a) => a.proxy_id);
    expect(remaining).toEqual([p2]);
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `bun test app/.server/proxy-resolver.test.ts -v`
Expected: FAIL — `Cannot find module "./proxy-resolver"` dan berkas modul belum ada.

- [ ] **Step 3: Tambah tabel & migrasi di `app/.server/db.ts`**

Setelah blok `provider_credentials` `CREATE TABLE` (baris ~165) tambahkan:

```ts
db.exec(`CREATE TABLE IF NOT EXISTS proxies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  protocol TEXT NOT NULL DEFAULT 'http',
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  username TEXT,
  password TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(host, port, protocol)
);`);

db.exec(`CREATE TABLE IF NOT EXISTS provider_proxies (
  provider_id TEXT NOT NULL REFERENCES providers(id),
  proxy_id INTEGER NOT NULL REFERENCES proxies(id),
  PRIMARY KEY(provider_id, proxy_id)
);`);
```

Tambahkan blok migrasi baru setelah blok migrasi legacy `provider_credentials` (habis baris ~207):

```ts
{
  const credCols = (
    query("PRAGMA table_info(provider_credentials)").all() as {
      name: string;
    }[]
  ).map((c) => c.name);
  if (credCols.length > 0 && !credCols.includes("proxy_id")) {
    db.exec("ALTER TABLE provider_credentials ADD COLUMN proxy_id INTEGER");
  }
}
```

- [ ] **Step 4: Buat `app/.server/proxy-resolver.ts` (fungsi CRUD saja)**

```ts
import { query } from "./db";

export type ProxyProtocol = "http" | "socks5";

export type ProxyRow = {
  id: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  is_active: number;
  last_used_at: number;
  created_at: number;
};

export type ProxyConfig = {
  id: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

export type ProxyInput = {
  protocol: ProxyProtocol;
  host: string;
  port: number;
  username: string | null;
  password: string | null;
};

const PROXY_COLS = "id, protocol, host, port, username, password, is_active, last_used_at, created_at";

export function listProxies(): ProxyRow[] {
  return query(
    `SELECT ${PROXY_COLS} FROM proxies ORDER BY id`,
  ).all() as unknown as ProxyRow[];
}

export function getProxy(id: number): ProxyRow | undefined {
  return query(
    `SELECT ${PROXY_COLS} FROM proxies WHERE id = ?`,
  ).get(id) as unknown as ProxyRow | undefined;
}

export function upsertProxy(
  input: ProxyInput,
): { id: number; inserted: boolean } {
  const res = query(
    `INSERT INTO proxies (protocol, host, port, username, password)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(host, port, protocol) DO NOTHING`,
  ).run(
    input.protocol,
    input.host,
    input.port,
    input.username,
    input.password,
  );
  const inserted = (res as { changes: number }).changes > 0;
  const row = query(
    "SELECT id FROM proxies WHERE host = ? AND port = ? AND protocol = ? LIMIT 1",
  ).get(input.host, input.port, input.protocol) as { id: number } | undefined;
  return { id: row?.id ?? -1, inserted };
}

export function updateProxy(id: number, fields: ProxyInput): void {
  query(
    `UPDATE proxies SET protocol = ?, host = ?, port = ?, username = ?, password = ?
     WHERE id = ?`,
  ).run(fields.protocol, fields.host, fields.port, fields.username, fields.password, id);
}

export function setProxyActive(id: number, active: boolean): void {
  query("UPDATE proxies SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
}

export function deleteProxy(id: number): void {
  query("DELETE FROM provider_proxies WHERE proxy_id = ?").run(id);
  query("UPDATE provider_credentials SET proxy_id = NULL WHERE proxy_id = ?").run(id);
  query("DELETE FROM proxies WHERE id = ?").run(id);
}

export function assignProxies(providerId: string, proxyIds: number[]): void {
  for (const proxyId of proxyIds) {
    query(
      "INSERT OR IGNORE INTO provider_proxies (provider_id, proxy_id) VALUES (?, ?)",
    ).run(providerId, proxyId);
  }
}

export function removeProxyAssignment(providerId: string, proxyId: number): void {
  query("DELETE FROM provider_proxies WHERE provider_id = ? AND proxy_id = ?").run(
    providerId,
    proxyId,
  );
}

export type AssignmentRow = {
  provider_id: string;
  provider_name: string;
  proxy_id: number;
  protocol: ProxyProtocol;
  host: string;
  port: number;
};

export function listAssignments(): AssignmentRow[] {
  return query(
    `SELECT pr.id AS provider_id, pr.name AS provider_name, px.id AS proxy_id,
            px.protocol, px.host, px.port
     FROM provider_proxies pp
     JOIN proxies px ON px.id = pp.proxy_id
     JOIN providers pr ON pr.id = pp.provider_id
     ORDER BY pr.id, px.port`,
  ).all() as unknown as AssignmentRow[];
}
```

- [ ] **Step 5: Jalankan test, pastikan pass**

Run: `bun test app/.server/proxy-resolver.test.ts -v`
Expected: PASS (6 test baru / +6 tests).

- [ ] **Step 6: Regresi + commit**

Run: `npm test`
Expected: 83 pass (77 existing + 6 baru).

```bash
git add app/.server/db.ts app/.server/proxy-resolver.ts app/.server/proxy-resolver.test.ts
git commit -m "feat: add proxy schema and CRUD helpers"
```

---

### Task 2: Parser bulk import (`parseBulkProxies`)

**Files:**
- Modify: `app/.server/proxy-resolver.ts` (tambah `parseBulkProxies` + helper pure)
- Test: `app/.server/proxy-resolver.test.ts`

**Interfaces:**
- Consumes: `ProxyInput`, `ProxyConfig` (Task 1)
- Produces:
  - `parseBulkProxies(text: string, existing?: ProxyConfig[]): { imported: ProxyInput[]; skipped: string[] }`
  - Format text per baris: `host:port`, `host:port:user:pass`, `host:port:user:pass`, `protocol://user:pass@host:port`, `[ipv6]:port[:user:pass]`, `protocol://user:pass@[ipv6]:port`
  - JSON: array of `{ protocol, host, port, username?, password? }` (protocol default `http`, wajib `http`/`socks5`).
  - Autodetect: teks diawali `[`/`{` → JSON; selain itu → per baris.
  - Duplicate (dalam input maupun vs `existing`) masuk `skipped` dengan pesan `duplicate: <protocol>://<host>:<port>`.

- [ ] **Step 1: Tulis test yang gagal**

Tambah ke `app/.server/proxy-resolver.test.ts` (tandai catatan: impor `parseBulkProxies` dilebur ke blok import teratas yang sudah ada, bukan import baru di tengah):

```ts
// Tambahkan "parseBulkProxies" pada imports dari "./proxy-resolver" di atas file.

describe("parseBulkProxies", () => {
  test("plain lines: host:port and host:port:user:pass", () => {
    const { imported, skipped } = parseBulkProxies(
      "1.2.3.4:8080\n5.6.7.8:3128:user:pass\n",
    );
    expect(skipped).toEqual([]);
    expect(imported).toEqual([
      { protocol: "http", host: "1.2.3.4", port: 8080, username: null, password: null },
      { protocol: "http", host: "5.6.7.8", port: 3128, username: "user", password: "pass" },
    ]);
  });

  test("url lines with protocol and credentials", () => {
    const { imported, skipped } = parseBulkProxies(
      "socks5://user:pass@10.0.0.1:1080\nhttp://10.0.0.2:8080\nhttp://u%40x:p%3Ay@10.0.0.3:8080",
    );
    expect(skipped).toEqual([]);
    expect(imported).toEqual([
      { protocol: "socks5", host: "10.0.0.1", port: 1080, username: "user", password: "pass" },
      { protocol: "http", host: "10.0.0.2", port: 8080, username: null, password: null },
      { protocol: "http", host: "10.0.0.3", port: 8080, username: "u@x", password: "p:y" },
    ]);
  });

  test("ipv6 bracketed", () => {
    const { imported, skipped } = parseBulkProxies("[::1]:1080\nhttp://u:p@[::1]:3128");
    expect(skipped).toEqual([]);
    expect(imported).toEqual([
      { protocol: "http", host: "::1", port: 1080, username: null, password: null },
      { protocol: "http", host: "::1", port: 3128, username: "u", password: "p" },
    ]);
  });

  test("json array", () => {
    const text = JSON.stringify([
      { protocol: "socks5", host: "pi.example", port: 1080 },
      { protocol: "http", host: "www.example", port: 80, username: "a", password: "b" },
    ]);
    const { imported, skipped } = parseBulkProxies(text);
    expect(skipped).toEqual([]);
    expect(imported).toEqual([
      { protocol: "socks5", host: "pi.example", port: 1080, username: null, password: null },
      { protocol: "http", host: "www.example", port: 80, username: "a", password: "b" },
    ]);
  });

  test("invalid entries skipped with reasons", () => {
    const { imported, skipped } = parseBulkProxies("not-a-proxy\n1.2.3.4:999999\n");
    expect(imported).toEqual([]);
    expect(skipped.length).toBe(2);
  });

  test("duplicates within input and vs existing are skipped", () => {
    const { imported, skipped } = parseBulkProxies(
      "1.2.3.4:8080\n1.2.3.4:8080\n2.3.4.5:8080",
      [{ id: 9, protocol: "http", host: "2.3.4.5", port: 8080, username: null, password: null }],
    );
    expect(imported).toEqual([
      { protocol: "http", host: "1.2.3.4", port: 8080, username: null, password: null },
    ]);
    expect(skipped).toContain("duplicate: http://1.2.3.4:8080");
    expect(skipped.some((s) => s.includes("2.3.4.5"))).toBe(true);
  });

  test("empty input returns nothing", () => {
    expect(parseBulkProxies("  \n")).toEqual({ imported: [], skipped: [] });
  });
});
```

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `bun test app/.server/proxy-resolver.test.ts -v`
Expected: FAIL — `parseBulkProxies` tidak terdefinisi.

- [ ] **Step 3: Implementasi `parseBulkProxies` di `app/.server/proxy-resolver.ts`**

```ts
function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536;
}

function parsePlainLine(s: string): ProxyInput | { error: string } {
  if (s.startsWith("[")) {
    const m = s.match(/^\[([^\]]+)\](?::(\d+))?(?::(.*))?$/);
    if (!m || !m[1]) return { error: "invalid format" };
    const port = m[2] ? Number(m[2]) : 1080;
    if (!validPort(port)) return { error: "invalid port" };
    let username: string | null = null;
    let password: string | null = null;
    if (m[3]) {
      const [u, ...rest] = m[3].split(":");
      username = u || null;
      password = rest.join(":") || null;
    }
    return { protocol: "http", host: m[1], port, username, password };
  }
  const parts = s.split(":");
  if (parts.length < 2 || parts.length > 4) return { error: "invalid format" };
  const host = parts[0];
  const port = Number(parts[1]);
  if (!host || !validPort(port)) return { error: "invalid format" };
  let username: string | null = null;
  let password: string | null = null;
  if (parts.length === 3) {
    username = parts[2] || null;
  } else if (parts.length === 4) {
    username = parts[2] || null;
    password = parts[3];
  }
  return { protocol: "http", host, port, username, password };
}

function parseUrlLine(s: string): ProxyInput | { error: string } {
  const m = s.match(
    /^(https?|socks5):\/\/(?:([^:@/]+)(?::([^@/]*))?@)?(\[[^\]]+\]|[^:/]+):(\d+)\/?$/i,
  );
  if (!m) return { error: "invalid URL format" };
  const scheme = m[1]!.toLowerCase();
  const host = m[4]!.startsWith("[") ? m[4]!.slice(1, -1) : m[4]!;
  const port = Number(m[5]);
  if (!validPort(port)) return { error: "invalid port" };
  return {
    protocol: scheme === "socks5" ? "socks5" : "http",
    host,
    port,
    username: m[2] != null ? decodeURIComponent(m[2]) : null,
    password: m[3] != null ? decodeURIComponent(m[3]) : null,
  };
}

export function parseBulkProxies(
  text: string,
  existing: ProxyConfig[] = [],
): { imported: ProxyInput[]; skipped: string[] } {
  const imported: ProxyInput[] = [];
  const skipped: string[] = [];
  const known = new Set(
    existing.map((p) => `${p.protocol}://${p.host}:${p.port}`),
  );
  const push = (item: ProxyInput | { error: string }, label: string): void => {
    if ("error" in item) {
      skipped.push(`${label}: ${item.error}`);
      return;
    }
    const key = `${item.protocol}://${item.host}:${item.port}`;
    if (known.has(key)) {
      skipped.push(`${key}: duplicate`);
      return;
    }
    known.add(key);
    imported.push(item);
  };
  const trimmed = text.trim();
  if (trimmed === "") return { imported, skipped };

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      skipped.push("JSON tidak valid");
      return { imported, skipped };
    }
    const items = Array.isArray(raw) ? raw : [raw];
    items.forEach((item, i) => {
      const label = `item ${i + 1}`;
      if (typeof item !== "object" || item === null) {
        skipped.push(`${label}: invalid format`);
        return;
      }
      const obj = item as Record<string, unknown>;
      if (typeof obj.host !== "string" || typeof obj.port !== "number") {
        skipped.push(`${label}: host/port required`);
        return;
      }
      const protocol =
        typeof obj.protocol === "string" ? obj.protocol.toLowerCase() : "http";
      if (protocol !== "http" && protocol !== "socks5") {
        skipped.push(`${label}: protocol harus http/socks5`);
        return;
      }
      if (!validPort(obj.port)) {
        skipped.push(`${label}: invalid port`);
        return;
      }
      push(
        {
          protocol,
          host: obj.host,
          port: obj.port,
          username:
            typeof obj.username === "string" && obj.username !== "" ? obj.username : null,
          password:
            typeof obj.password === "string" && obj.password !== "" ? obj.password : null,
        },
        label,
      );
    });
    return { imported, skipped };
  }

  text.split("\n").forEach((line, i) => {
    const l = line.trim();
    if (l === "") return;
    push(l.includes("://") ? parseUrlLine(l) : parsePlainLine(l), `line ${i + 1}`);
  });
  return { imported, skipped };
}
```

Catatan: test URL-garuda di Step 1 memakai `.replace()` agar string tetap eksplisit — pertahankan apa adanya (string di atas sudah benar: baris ke-3 menjadi `http://u%40x:p%3Ay@10.0.0.3:8080`).

- [ ] **Step 4: Jalankan test, pastikan pass**

Run: `bun test app/.server/proxy-resolver.test.ts -v`
Expected: PASS (7 test parse baru).

- [ ] **Step 5: Regresi + commit**

Run: `npm test`
Expected: 90 pass (83 + 7 baru).

```bash
git add app/.server/proxy-resolver.ts app/.server/proxy-resolver.test.ts
git commit -m "feat: add parseBulkProxies for text and JSON import"
```

---

### Task 3: Resolusi & transport (`getActivePool`, `roundRobinPick`, `resolveProxy`, `resolveProxyCandidates`, `formatProxy`, `fetchUpstream`, `testProxyConnection`)

**Files:**
- Modify: `app/.server/proxy-resolver.ts`
- Modify: `app/.server/credential.ts` (tambah `proxy_id` di `ApiKeyRow`/`listApiKeys`, `getRoutingCredential`)
- Test: `app/.server/proxy-resolver.test.ts`

**Interfaces:**
- Consumes: `ProxyConfig`, `ProxyRow`, `getProxy` (Task 1); `getRoutingCredential` (dibuat di task ini)
- Produces:
  - `getActivePool(providerId: string): ProxyConfig[]` — proxy aktif milik provider, urut `last_used_at` asc
  - `roundRobinPick(pool: ProxyConfig[]): ProxyConfig | undefined` — pilih yang paling lama tak terpakai, lalu `touchProxy(id)`
  - `resolveProxy(providerId: string): ProxyConfig | null` — single (test koneksi/modelsUrl): key > pool > direct
  - `resolveProxyCandidates(providerId: string): ProxyConfig[]` — chat: key → `[key]`; pool → array terurut dgn elemen pertama sudah di-roundRobinPick
  - `formatProxy(proxy: ProxyConfig): { proxy: string } | { socks: string }`
  - `fetchUpstream(url: string, init: RequestInit & { proxy?: string; socks?: string }, proxy: ProxyConfig | null): Promise<Response>`
  - `testProxyConnection(proxy: ProxyConfig): Promise<{ ok: boolean; message: string }>`
  - `getRoutingCredential(providerId: string): { api_key: string; proxy_id: number | null } | null` (credential.ts)

- [ ] **Step 1: Tulis test yang gagal**

Gabungkan import tambahan ke blok `import` teratas berkas `app/.server/proxy-resolver.test.ts` yang sudah ada dari Task 1 (jangan buat blok import kedua di tengah file):

```ts
// Tambahkan pada imports yang sudah ada:
import {
  assignProxies,
  fetchUpstream,
  formatProxy,
  getActivePool,
  resolveProxy,
  resolveProxyCandidates,
  roundRobinPick,
  touchProxy,
  upsertProxy,
} from "./proxy-resolver";
import { getRoutingCredential } from "./credential";

describe("getActivePool & roundRobinPick", () => {
  test("returns only active proxies, most-recently-used last", () => {
    const a = upsertProxy({ protocol: "http", host: "p1.example", port: 1080, username: null, password: null });
    const b = upsertProxy({ protocol: "http", host: "p2.example", port: 1081, username: null, password: null });
    const d = upsertProxy({ protocol: "http", host: "dead.example", port: 1082, username: null, password: null });
    setProxyActive(d.id, false);
    assignProxies("openai", [a.id, b.id, d.id]);
    touchProxy(a.id); // p1 jadi "paling baru dipakai" → harus terakhir
    const pool = getActivePool("openai");
    expect(pool.map((p) => p.host)).toEqual(["p2.example", "p1.example"]);
  });

  test("roundRobinPick rotates through pool", () => {
    const a = upsertProxy({ protocol: "http", host: "r1.example", port: 1080, username: null, password: null });
    const b = upsertProxy({ protocol: "http", host: "r2.example", port: 1081, username: null, password: null });
    assignProxies("anthropic", [a.id, b.id]);
    const first = roundRobinPick(getActivePool("anthropic"));
    expect(first?.host).toBe("r1.example");
    const second = roundRobinPick(getActivePool("anthropic"));
    expect(second?.host).toBe("r2.example");
    expect(roundRobinPick([])).toBeUndefined();
  });
});

describe("resolveProxy hierarchy", () => {
  test("touches last_used_at via pick", () => {
    const a = upsertProxy({ protocol: "http", host: "t1.example", port: 1080, username: null, password: null });
    const before = getProxy(a.id)!.last_used_at;
    touchProxy(a.id);
    expect(getProxy(a.id)!.last_used_at).toBeGreaterThanOrEqual(before);
  });
});

describe("resolveProxy candidates", () => {
  test("key proxy wins over pool", () => {
    const key = upsertProxy({ protocol: "http", host: "key.example", port: 1080, username: null, password: null });
    const pool = upsertProxy({ protocol: "http", host: "pool.example", port: 1081, username: null, password: null });
    assignProxies("groq", [pool.id]);
    query(
      "INSERT INTO provider_credentials (provider_id, label, api_key, is_active, is_routing, proxy_id, updated_at) VALUES ('groq', 't', 'k', 1, 1, ?, unixepoch())",
    ).run(key.id);
    expect(resolveProxy("groq")?.host).toBe("key.example");
    expect(resolveProxyCandidates("groq").map((p) => p.host)).toEqual(["key.example"]);
  });

  test("pool only when no key proxy", () => {
    const a = upsertProxy({ protocol: "http", host: "c1.example", port: 1080, username: null, password: null });
    assignProxies("google", [a.id]);
    const hosts = resolveProxyCandidates("google").map((p) => p.host);
    expect(hosts).toContain("c1.example");
  });

  test("null when no proxy configured", () => {
    expect(resolveProxy("mistral")).toBeNull();
    expect(resolveProxyCandidates("mistral")).toEqual([]);
  });
});

describe("credential proxy helpers", () => {
  test("getRoutingCredential returns proxy_id of routing key", () => {
    const key = upsertProxy({ protocol: "http", host: "cred.example", port: 1080, username: null, password: null });
    query(
      "INSERT INTO provider_credentials (provider_id, label, api_key, is_active, is_routing, proxy_id, updated_at) VALUES ('openrouter', 't', 'k', 1, 1, ?, unixepoch())",
    ).run(key.id);
    expect(getRoutingCredential("openrouter")?.proxy_id).toBe(key.id);
  });
});

describe("formatProxy", () => {
  test("http and socks5 output", () => {
    expect(formatProxy({ id: 1, protocol: "http", host: "h", port: 80, username: "u", password: "p" })).toEqual({ proxy: "http://u:p@h:80" });
    expect(formatProxy({ id: 2, protocol: "socks5", host: "h", port: 1080, username: null, password: null })).toEqual({ socks: "socks5://h:1080" });
  });
});

describe("fetchUpstream", () => {
  test("injects proxy/socks option and passes through without proxy", async () => {
    let captured: { url: string; init: unknown } | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = async (url: unknown, init: unknown) => {
      captured = { url: String(url), init };
      return new Response("ok");
    };
    try {
      await fetchUpstream("http://up.example/v1", { method: "POST" }, { id: 1, protocol: "http", host: "px", port: 8080, username: "u", password: "p" });
      expect(captured!.init).toMatchObject({ proxy: "http://u:p@px:8080" });
      await fetchUpstream("http://up.example/v1", { method: "POST" }, null);
      expect((captured!.init as Record<string, unknown>).proxy).toBeUndefined();
      expect((captured!.init as Record<string, unknown>).method).toBe("POST");
    } finally {
      globalThis.fetch = original;
    }
  });
});
```

Catatan: `setProxyActive`, `getProxy`, `query` perlu di-import di blok test atas (sudah ada di Task 1). Tambahkan import `setKeyProxy`, `getRoutingCredential`, `touchProxy`, `fetchUpstream` sesuai blok di atas.

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `bun test app/.server/proxy-resolver.test.ts -v`
Expected: FAIL — `roundRobinPick`, `resolveProxy`, dll belum ada; `setKeyProxy`/`getRoutingCredential` di credential.ts belum ada.

- [ ] **Step 3: Update `app/.server/credential.ts`**

Perluas `ApiKeyRow` (tambah `proxy_id`), `listApiKeys` (tambah kolom), dan tambah fungsi baru:

```ts
export type ApiKeyRow = {
  id: number;
  provider_id: string;
  label: string | null;
  api_key: string;
  is_active: number;
  is_routing: number;
  proxy_id: number | null;
  created_at: number;
  updated_at: number;
};

export function listApiKeys(providerId: string): ApiKeyRow[] {
  return query(
    `SELECT id, provider_id, label, api_key, is_active, is_routing, proxy_id, created_at, updated_at
     FROM provider_credentials WHERE provider_id = ? ORDER BY id`,
  ).all(providerId) as unknown as ApiKeyRow[];
}

export function setKeyProxy(id: number, proxyId: number | null): void {
  query(
    "UPDATE provider_credentials SET proxy_id = ?, updated_at = unixepoch() WHERE id = ?",
  ).run(proxyId, id);
}

export function getRoutingCredential(
  providerId: string,
): { api_key: string; proxy_id: number | null } | null {
  const routing = query(
    "SELECT api_key, proxy_id FROM provider_credentials WHERE provider_id = ? AND is_routing = 1 AND is_active = 1 ORDER BY id LIMIT 1",
  ).get(providerId) as { api_key: string; proxy_id: number | null } | undefined;
  if (routing) return routing;
  const fallback = query(
    "SELECT api_key, proxy_id FROM provider_credentials WHERE provider_id = ? AND is_active = 1 ORDER BY id LIMIT 1",
  ).get(providerId) as { api_key: string; proxy_id: number | null } | undefined;
  return fallback ?? null;
}
```

- [ ] **Step 4: Implementasi fungsi resolusi/transport di `app/.server/proxy-resolver.ts`**

Tambah import `getRoutingCredential` dari `./credential` di atas berkas, lalu:

```ts
export function getActivePool(providerId: string): ProxyConfig[] {
  const rows = query(
    `SELECT px.id, px.protocol, px.host, px.port, px.username, px.password, px.last_used_at
     FROM provider_proxies pp
     JOIN proxies px ON px.id = pp.proxy_id
     WHERE pp.provider_id = ? AND px.is_active = 1
     ORDER BY px.last_used_at, px.id`,
  ).all(providerId) as unknown as (ProxyConfig & { last_used_at: number })[];
  return rows.map(({ last_used_at: _omit, ...rest }) => rest);
}

export function touchProxy(id: number): void {
  query("UPDATE proxies SET last_used_at = ? WHERE id = ?").run(Date.now(), id);
}

export function roundRobinPick(
  pool: ProxyConfig[],
): ProxyConfig | undefined {
  if (pool.length === 0) return undefined;
  const picked = pool[0];
  touchProxy(picked.id);
  return picked;
}

function getKeyProxy(providerId: string): ProxyConfig | null {
  const cred = getRoutingCredential(providerId);
  if (!cred?.proxy_id) return null;
  const row = query(
    "SELECT id, protocol, host, port, username, password FROM proxies WHERE id = ? AND is_active = 1",
  ).get(cred.proxy_id) as ProxyConfig | undefined;
  return row ?? null;
}

export function resolveProxy(providerId: string): ProxyConfig | null {
  const keyProxy = getKeyProxy(providerId);
  if (keyProxy) return keyProxy;
  const pool = getActivePool(providerId);
  if (pool.length === 0) return null;
  return roundRobinPick(pool);
}

export function resolveProxyCandidates(providerId: string): ProxyConfig[] {
  const keyProxy = getKeyProxy(providerId);
  if (keyProxy) return [keyProxy];
  const pool = getActivePool(providerId);
  if (pool.length === 0) return [];
  const picked = roundRobinPick(pool);
  return [picked!, ...pool.filter((p) => p.id !== picked!.id)];
}

export function formatProxy(
  proxy: ProxyConfig,
): { proxy: string } | { socks: string } {
  const cred = proxy.username
    ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? "")}@`
    : "";
  const host =
    proxy.host.includes(":") && !proxy.host.startsWith("[")
      ? `[${proxy.host}]`
      : proxy.host;
  const url = `${proxy.protocol}://${cred}${host}:${proxy.port}`;
  return proxy.protocol === "http" ? { proxy: url } : { socks: url };
}

export function fetchUpstream(
  url: string,
  init: RequestInit & { proxy?: string; socks?: string },
  proxy: ProxyConfig | null,
): Promise<Response> {
  return fetch(url, proxy ? { ...init, ...formatProxy(proxy) } : init);
}

export async function testProxyConnection(
  proxy: ProxyConfig,
): Promise<{ ok: boolean; message: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetchUpstream(
      "https://www.gstatic.com/generate_204",
      { method: "GET", signal: controller.signal },
      proxy,
    );
    return { ok: true, message: `HTTP ${res.status}` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
```

> Catatan round-robin: `roundRobinPick(pool)` menganggap `pool` sudah terurut `last_used_at` (`getActivePool` menjamin ini lewat `ORDER BY px.last_used_at, px.id`); pick memakai `pool[0]` (paling lama tak terpakai), lalu `touchProxy` menaikkan `last_used_at` sehingga pool bergiliran pada panggilan berikutnya — setara pola `sort((a,b)=>a.last_used_at-b.last_used_at)[0]` di `balancer.ts`.

- [ ] **Step 5: Jalankan test, pastikan pass**

Run: `bun test app/.server/proxy-resolver.test.ts -v`
Expected: PASS (test Task 1-3).

- [ ] **Step 6: Regresi (cek adapter/credential) + commit**

Run: `bun test app/.server/credential.test.ts app/.server/adapter.test.ts app/.server/proxy-resolver.test.ts -v && npm test`
Expected: semua pass (existing + new Task 3: 9 test tambahan di proxy-resolver.test.ts).

```bash
git add app/.server/proxy-resolver.ts app/.server/proxy-resolver.test.ts app/.server/credential.ts
git commit -m "feat: add proxy resolution and transport via fetchUpstream"
```

---

### Task 4: Integrasi executor (failover antar proxy)

**Files:**
- Modify: `app/.server/executor.ts`
- Test: `app/.server/executor.test.ts` (baru)

**Interfaces:**
- Consumes: `ProxyConfig`, `fetchUpstream` (Task 3)
- Produces:
  - `ExecutorOptions.proxies?: ProxyConfig[]`
  - `executeStreaming(options)` — bila `options.proxies` berisi >0, iterasi tiap proxy sampai sukses/bukan-retryable; bila kosong, perilaku lama (retry 1x) tetap.

- [ ] **Step 1: Tulis test yang gagal**

Create `app/.server/executor.test.ts`:

```ts
import "./test-env";
import { describe, expect, test } from "bun:test";
import { executeStreaming } from "./executor";
import type { ExecutorOptions } from "./executor";

type Calls = { url: string; init: Record<string, unknown> }[];

function makeCalls() {
  const calls: Calls = [];
  globalThis.fetch = async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as Record<string, unknown> });
    return new Response("ok", { status: 200 });
  };
  return calls;
}

function options(proxies: ExecutorOptions["proxies"]): ExecutorOptions {
  return {
    url: "http://up.example/v1/chat/completions",
    headers: new Headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model: "gpt-4o" }),
    proxies,
    onComplete: () => {},
  };
}

describe("executeStreaming proxy failover", () => {
  test("uses first proxy on success", async () => {
    const calls = makeCalls();
    const res = await executeStreaming(
      options([
        { id: 1, protocol: "http", host: "a", port: 8080, username: "u", password: "p" },
        { id: 2, protocol: "http", host: "b", port: 8081, username: null, password: null },
      ]),
    );
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
    expect(calls[0].init.proxy).toBe("http://u:p@a:8080");
  });

  test("fails over to next proxy on connect error", async () => {
    let n = 0;
    globalThis.fetch = async (_url: unknown, init: unknown) => {
      n += 1;
      if (n === 1) throw new Error("connect refused");
      return new Response("ok", { status: 200 });
    };
    const res = await executeStreaming(
      options([
        { id: 1, protocol: "socks5", host: "a", port: 1080, username: null, password: null },
        { id: 2, protocol: "socks5", host: "b", port: 1081, username: null, password: null },
      ]),
    );
    expect(res.status).toBe(200);
    expect(n).toBe(2);
  });

  test("non-retryable status (401) stops, not fallback", async () => {
    const calls = makeCalls();
    globalThis.fetch = async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as Record<string, unknown> });
      return new Response(JSON.stringify({ error: { message: "proxy auth failed" } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    };
    const res = await executeStreaming(
      options([
        { id: 1, protocol: "http", host: "a", port: 8080, username: "u", password: "bad" },
        { id: 2, protocol: "http", host: "b", port: 8081, username: null, password: null },
      ]),
    );
    expect(res.status).toBe(401);
    expect(calls.length).toBe(1); // tidak coba proxy kedua (non-retryable)
  });

  test("no proxies keeps legacy single retry behavior", async () => {
    const calls = makeCalls();
    const res = await executeStreaming(options(undefined));
    expect(res.status).toBe(200);
    expect(calls.length).toBe(1);
  });
});
```

> Catatan: ≥ test "non-retryable status (401)" memverifikasi status 401 (di luar `RETRYABLE_STATUS`) langsung menghentikan loop failover — hanya 1 call.

- [ ] **Step 2: Jalankan test, pastikan gagal**

Run: `bun test app/.server/executor.test.ts -v`
Expected: FAIL — `ExecutorOptions.proxies` belum ada (TS error) / failover belum jalan.

- [ ] **Step 3: Implementasi di `app/.server/executor.ts`**

Ubah `ExecutorOptions` (tambah `proxies`), `attempt` (terima `proxy`, pakai `fetchUpstream`), dan `executeStreaming` (loop failover):

```ts
import { createStreamTransformer } from "./adapter";
import type { RequestLog } from "./logger";
import { fetchUpstream, type ProxyConfig } from "./proxy-resolver";

export type ExecutorOptions = {
  url: string;
  headers: Headers;
  body: string;
  signal?: AbortSignal;
  proxies?: ProxyConfig[];
  onComplete: (
    log: Partial<RequestLog> & Pick<RequestLog, "status">,
  ) => void;
};
```

`attempt` — ubah signature & bagian fetch:

```ts
async function attempt(
  options: ExecutorOptions,
  proxy?: ProxyConfig,
): Promise<AttemptResult> {
  const { url, headers, body, signal } = options;
  const controller = new AbortController();
  const abortFromCaller = (): void => controller.abort();
  signal?.addEventListener("abort", abortFromCaller);

  try {
    const upstream = await fetchUpstream(
      url,
      {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.any([
          AbortSignal.timeout(EXECUTE_TIMEOUT_MS),
          controller.signal,
        ]),
      },
      proxy ?? null,
    );

    if (!upstream.ok) {
      const detailText = await upstream.text();
      return {
        ok: false,
        status: upstream.status,
        detailText,
        retryable: RETRYABLE_STATUS.has(upstream.status),
      };
    }
    if (!upstream.body) {
      return {
        ok: false,
        status: 502,
        detailText: JSON.stringify({
          error: { message: "upstream returned empty body" },
        }),
        retryable: false,
      };
    }

    return { ok: true, response: buildStreamResponse(upstream, controller, options) };
  } catch (err) {
    controller.abort();
    const raw = err instanceof Error ? err.message : String(err);
    const context = proxy ? `proxy connect failed: ${proxy.host}:${proxy.port}` : "";
    const message = context ? `${context} (${raw})` : raw;
    return {
      ok: false,
      status: 502,
      detailText: JSON.stringify({ error: { message } }),
      retryable: true,
    };
  } finally {
    signal?.removeEventListener("abort", abortFromCaller);
  }
}
```

`executeStreaming` — ganti loop retry:

```ts
export async function executeStreaming(
  options: ExecutorOptions,
): Promise<Response> {
  const started = Date.now();
  const proxies = options.proxies ?? [];

  let result: AttemptResult;
  if (proxies.length > 0) {
    result = await attempt(options, proxies[0]);
    for (let i = 1; i < proxies.length && !result.ok && result.retryable; i++) {
      result = await attempt(options, proxies[i]);
    }
  } else {
    result = await attempt(options);
    if (!result.ok && result.retryable) {
      result = await attempt(options);
    }
  }

  if (!result.ok) {
    options.onComplete({
      status: "error",
      error_message: result.detailText,
      duration_ms: Date.now() - started,
    });
    return new Response(result.detailText, {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  }

  return result.response;
}
```

- [ ] **Step 4: Jalankan test, pastikan pass**

Run: `bun test app/.server/executor.test.ts -v`
Expected: PASS.

- [ ] **Step 5: Regresi + commit**

Run: `npm test && npm run typecheck`
Expected: pass + typecheck bersih.

```bash
git add app/.server/executor.ts app/.server/executor.test.ts
git commit -m "feat: route executor through proxies with failover"
```

---

### Task 5: Wiring chat route (`v1.chat.completions.ts`)

**Files:**
- Modify: `app/routes/v1.chat.completions.ts`

**Interfaces:**
- Consumes: `resolveProxyCandidates(providerId): ProxyConfig[]` (Task 3), `ExecutorOptions.proxies` (Task 4)

- [ ] **Step 1: Implementasi**

Di `app/routes/v1.chat.completions.ts`, tambah import:

```ts
import { resolveProxyCandidates } from "../.server/proxy-resolver";
```

Pada panggilan `executeStreaming` di dalam perulangan `for (const provider of candidates)` (baris ~241), tambahkan `proxies`:

```ts
    response = await executeStreaming({
      url: transformed.url,
      headers: transformed.headers,
      body: transformed.body,
      signal: request.signal,
      proxies: resolveProxyCandidates(provider.id),
      onComplete: (log) => {
        recordRequestLog({
          model: effectiveModel,
          provider_id: provider.id,
          strategy_used: cfg.strategy,
          rule_applied: ruleApplied,
          ...log,
        });
        endConnection(provider.id);
      },
    });
```

- [ ] **Step 2: Jalankan test route + regresi**

Run: `bun test app/.server/v1.chat.completions.test.ts -v`
Expected: PASS (perilaku direct tidak berubah — pool kosong → tanpa proxy).

Run: `npm test && npm run typecheck`
Expected: pass + typecheck bersih.

- [ ] **Step 3: Commit**

```bash
git add app/routes/v1.chat.completions.ts
git commit -m "feat: resolve per-provider proxies in chat route"
```

---

### Task 6: Proxy per API key (provider credentials + UI + test-key + delete-provider cleanup)

> **Deviation dari design §6:** design doc menaruh select proxy di `EditKeyForm` (`app/routes/api.tsx`), padahal `api.tsx` mengelola **client keys** (tabel `client_api_keys`, tidak punya `provider_id`). `proxy_id` didefinisikan di `provider_credentials` karena itu per-akun provider. Maka UI proxy per API key diletakkan di **`app/routes/providers.$id.tsx`** (tab API Keys, tempat `addApiKey`/`setRoutingKey`/`listApiKeys`). `api.tsx` **tidak** diubah.

**Files:**
- Modify: `app/routes/providers.$id.tsx`
- Consumes: `listProxies`, `resolveProxyForKey` (buat di task ini), `listApiKeys` (Task 3, sekarang mengembalikan `proxy_id`), `setKeyProxy`, `fetchUpstream`
- Produces:
  - `resolveProxyForKey(providerId: string, keyProxyId: number | null): ProxyConfig | null` (di proxy-resolver.ts)

- [ ] **Step 1: Tambah `resolveProxyForKey` di `app/.server/proxy-resolver.ts`**

```ts
export function resolveProxyForKey(
  providerId: string,
  keyProxyId: number | null,
): ProxyConfig | null {
  if (keyProxyId) {
    const row = query(
      "SELECT id, protocol, host, port, username, password FROM proxies WHERE id = ? AND is_active = 1",
    ).get(keyProxyId) as ProxyConfig | undefined;
    if (row) return row;
  }
  const pool = getActivePool(providerId);
  if (pool.length === 0) return null;
  return roundRobinPick(pool);
}
```

- [ ] **Step 2: Tulis/update test resolusi per key**

Tambah ke `app/.server/proxy-resolver.test.ts`:

```ts
// Tambahkan "resolveProxyForKey" pada imports dari "./proxy-resolver" di atas file.

describe("resolveProxyForKey", () => {
  test("uses key proxy when active", () => {
    const key = upsertProxy({ protocol: "http", host: "kf.example", port: 1080, username: null, password: null });
    expect(resolveProxyForKey("cohere", key.id)?.host).toBe("kf.example");
  });

  test("falls back to pool when key proxy inactive", () => {
    const key = upsertProxy({ protocol: "http", host: "kz.example", port: 1080, username: null, password: null });
    setProxyActive(key.id, false);
    const pool = upsertProxy({ protocol: "http", host: "pk.example", port: 1081, username: null, password: null });
    assignProxies("dahl", [pool.id]);
    expect(resolveProxyForKey("dahl", key.id)?.host).toBe("pk.example");
  });

  test("null keys return null", () => {
    expect(resolveProxyForKey("opencode", null)).toBeNull();
  });
});
```

- [ ] **Step 3: Uptimize `providers.$id.tsx`**

1. Import tambahan di `app/routes/providers.$id.tsx`:
```ts
import { listProxies } from "../.server/proxy-resolver";
import { resolveProxyForKey } from "../.server/proxy-resolver";
import { fetchUpstream } from "../.server/proxy-resolver";
```
> Ditulis terpisah agar mudah dilebur ke blok import yang sudah ada; boleh digabung jadi satu `import { fetchUpstream, listProxies, resolveProxyForKey } from "../.server/proxy-resolver";`. `listProxies` untuk option select; `fetchUpstream` untuk `test-key`.

Tambah juga import `setKeyProxy` dari `../.server/credential` (digabung dengan import `credential` yang sudah ada).

2. `loader` — kembalikan juga daftar proxy untuk select:
```ts
  const proxies = listProxies();
  ...
  return {
    provider: provider ?? null,
    keys,
    models,
    missingModels,
    entry: entry ?? null,
    proxies,
  };
```

3. `action` `test-key` — route lewat proxy milik key bila ada (`providers.$id.tsx` baris ~121-128):
```ts
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const proxy = resolveProxyForKey(id, key.proxy_id ?? null);
      const res = await fetchUpstream(
        modelsUrl,
        { headers, signal: controller.signal },
        proxy,
      );
      clearTimeout(timer);
      if (res.ok) {
        return { test: { ok: true, okId: keyId, message: "Terhubung" } };
      }
      const text = (await res.text()).slice(0, 300);
      return {
        test: {
          ok: false,
          okId: keyId,
          message: `HTTP ${res.status}: ${text}`,
        },
      };
    } catch (err) {
      return {
        test: {
          ok: false,
          okId: keyId,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
```

4. Tambah intent `set-key-proxy` di `action`:
```ts
  if (intent === "set-key-proxy") {
    const keyId = Number(form.get("key_id"));
    const proxyIdRaw = String(form.get("proxy_id") ?? "").trim();
    setKeyProxy(keyId, proxyIdRaw === "" ? null : Number(proxyIdRaw));
    return null;
  }
```
Tambah import `setKeyProxy` dari `../.server/credential`.

5. `delete-provider` — bersihkan child rows (termasuk provider_proxies, agar FK tidak menolak hapus provider). Urutan hapus child sebelum parent:
```ts
    query("DELETE FROM provider_proxies WHERE provider_id = ?").run(id);
    query("DELETE FROM provider_credentials WHERE provider_id = ?").run(id);
    query("DELETE FROM models WHERE provider_id = ?").run(id);
    query("DELETE FROM providers WHERE id = ?").run(id);
    reload();
    return { deleted: true };
```

6. UI — tambah select proxy per key. Pada kartu key (`providers.$id.tsx` area daftar key, sebelum tombol Test), tambahkan Form:
```tsx
                      <Form method="post">
                        <input type="hidden" name="intent" value="set-key-proxy" />
                        <input type="hidden" name="key_id" value={key.id} />
                        <div className="flex items-center gap-1">
                          <select
                            name="proxy_id"
                            defaultValue={key.proxy_id ?? ""}
                            onChange={(e) => e.target.form?.requestSubmit()}
                            className="rounded-lg border border-gray-300 px-2 py-1.5 text-xs text-gray-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
                          >
                            <option value="">direct</option>
                            {proxies.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.protocol}://{p.host}:{p.port}
                              </option>
                            ))}
                          </select>
                        </div>
                      </Form>
```
Destructure `proxies` dari `loaderData` pada komponen default (`const { provider, keys, models, missingModels, entry, proxies } = loaderData;`).

- [ ] **Step 4: Jalankan test resolver + regresi**

Run: `bun test app/.server/proxy-resolver.test.ts -v && npm test && npm run typecheck`
Expected: pass semua.

- [ ] **Step 5: Commit**

```bash
git add app/.server/proxy-resolver.ts app/.server/proxy-resolver.test.ts app/routes/providers.$id.tsx
git commit -m "feat: per-api-key proxy selection on provider credentials"
```

---

### Task 7: Scope test koneksi & modelsUrl (`providers.tsx`)

**Files:**
- Modify: `app/routes/providers.tsx`

**Interfaces:**
- Consumes: `resolveProxy(id)`, `resolveProxyForKey`, `fetchUpstream` (Task 3 & 6), `key.proxy_id` (Task 3)

- [ ] **Step 1: Implementasi**

Di `app/routes/providers.tsx`:

Tambah import:
```ts
import { fetchUpstream } from "../.server/proxy-resolver";
import { resolveProxy, resolveProxyForKey } from "../.server/proxy-resolver";
```

Cakupan 1 — provider `auth_type === "none"` (tidak ada key): gunakan pool provider → `resolveProxy`:
```ts
  if (provider.auth_type === "none") {
    return (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const proxy = resolveProxy(providerId);
        const res = await fetchUpstream(
          modelsUrl,
          { signal: controller.signal },
          proxy,
        );
        clearTimeout(timer);
        return { connected: res.ok ? 1 : 0, total: 1 };
      } catch {
        return { connected: 0, total: 1 };
      }
    })();
  }
```

Cakupan 2 — loop key: route per key lewat proxy-nya (pool fallback):
```ts
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const proxy = resolveProxyForKey(providerId, key.proxy_id ?? null);
        const res = await fetchUpstream(
          modelsUrl,
          { headers, signal: controller.signal },
          proxy,
        );
        clearTimeout(timer);
        if (res.ok) connected += 1;
      } catch {
        /* skip */
      }
```

- [ ] **Step 2: Regresi + commit**

Run: `npm test && npm run typecheck && npm run build`
Expected: pass semua.

```bash
git add app/routes/providers.tsx
git commit -m "feat: route connection tests and modelsUrl fetch through proxies"
```

---

### Task 8: Halaman UI `/proxies` + sidebar

**Files:**
- Create: `app/routes/proxies.tsx`
- Modify: `app/components/sidebar.tsx`

**Interfaces:**
- Consumes: `listProxies`, `upsertProxy`, `updateProxy`, `deleteProxy`, `setProxyActive`, `assignProxies`, `removeProxyAssignment`, `listAssignments`, `parseBulkProxies`, `getProxy`, `testProxyConnection` (Task 1-3)

- [ ] **Step 1: Sidebar — tambah menu `Proxies`**

Di `app/components/sidebar.tsx`, tambah import `Network` dari `lucide-react` dan item nav setelah `/proxy`:

```ts
import { Network } from "lucide-react";
...
const NAV_ITEMS = [
  { to: "/home", label: "Home", icon: Home },
  { to: "/providers", label: "Provider", icon: Plug },
  { to: "/compression", label: "Compression", icon: FileArchive },
  { to: "/api", label: "API", icon: KeyRound },
  { to: "/combo", label: "Combo", icon: Link2 },
  { to: "/proxy", label: "Proxy", icon: Globe },
  { to: "/proxies", label: "Proxies", icon: Network },
];
```

- [ ] **Step 2: Buat `app/routes/proxies.tsx` (loader + action + 3 tab)**

```tsx
import { Form, useFetcher } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/proxies";
import { Network, Plus, Trash2, Upload } from "lucide-react";
import { query } from "../.server/db";
import {
  assignProxies,
  deleteProxy,
  getProxy,
  listAssignments,
  listProxies,
  parseBulkProxies,
  removeProxyAssignment,
  setProxyActive,
  testProxyConnection,
  updateProxy,
  upsertProxy,
  type ProxyProtocol,
  type ProxyRow,
} from "../.server/proxy-resolver";

function strOrNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

export function loader() {
  const proxies = listProxies();
  const providers = query(
    "SELECT id, name FROM providers ORDER BY id",
  ).all() as unknown as { id: string; name: string }[];
  const assignments = listAssignments();
  return { proxies, providers, assignments };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "add") {
    upsertProxy({
      protocol: (form.get("protocol") as ProxyProtocol) || "http",
      host: String(form.get("host") ?? "").trim(),
      port: Number(form.get("port")),
      username: strOrNull(form.get("username")),
      password: strOrNull(form.get("password")),
    });
    return null;
  }

  if (intent === "update") {
    updateProxy(Number(form.get("id")), {
      protocol: (form.get("protocol") as ProxyProtocol) || "http",
      host: String(form.get("host") ?? "").trim(),
      port: Number(form.get("port")),
      username: strOrNull(form.get("username")),
      password: strOrNull(form.get("password")),
    });
    return null;
  }

  if (intent === "delete") {
    deleteProxy(Number(form.get("id")));
    return null;
  }

  if (intent === "toggle") {
    setProxyActive(Number(form.get("id")), form.get("is_active") === "1");
    return null;
  }

  if (intent === "test") {
    const id = Number(form.get("id"));
    const proxy = getProxy(id);
    if (!proxy) return { test: { id, ok: false, message: "Proxy tidak ditemukan" } };
    return { test: { id, ...(await testProxyConnection(proxy)) } };
  }

  if (intent === "import") {
    const { imported, skipped } = parseBulkProxies(
      String(form.get("text") ?? ""),
      listProxies(),
    );
    let insertedCount = 0;
    for (const entry of imported) {
      if (upsertProxy(entry).inserted) insertedCount += 1;
    }
    return { importSummary: { imported: insertedCount, skipped } };
  }

  if (intent === "assign") {
    const providerId = String(form.get("provider_id") ?? "").trim();
    const ids = form.getAll("proxy_id").map(Number).filter(Number.isInteger);
    if (providerId && ids.length > 0) assignProxies(providerId, ids);
    return null;
  }

  if (intent === "unassign") {
    removeProxyAssignment(
      String(form.get("provider_id")),
      Number(form.get("proxy_id")),
    );
    return null;
  }

  return null;
}

function inputClass() {
  return "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
}

export default function Proxies({ loaderData, actionData }: Route.ComponentProps) {
  const { proxies, providers, assignments } = loaderData;
  const [tab, setTab] = useState<"list" | "import" | "assign">("list");
  const [editing, setEditing] = useState<number | null>(null);
  const fetcher = useFetcher<{ test?: { id: number; ok: boolean; message: string } }>();
  const testResult = fetcher.data?.test;
  const importSummary = actionData
    ? (actionData as { importSummary?: { imported: number; skipped: string[] } }).importSummary
    : undefined;

  const tabBtn = (label: string, id: "list" | "import" | "assign") => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${
        tab === id
          ? "bg-blue-600 text-white"
          : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <Network size={24} /> Proxies
      </h1>
      <div className="tabs-scroll mb-6">
        {tabBtn("Daftar Proxy", "list")}
        {tabBtn("Bulk Import", "import")}
        {tabBtn("Bulk Assignment", "assign")}
      </div>

      {tab === "list" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <Form method="post" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <input type="hidden" name="intent" value="add" />
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Protocol</label>
              <select name="protocol" defaultValue="http" className={inputClass()}>
                <option value="http">http</option>
                <option value="socks5">socks5</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Host</label>
              <input name="host" required placeholder="proxy.example" className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Port</label>
              <input name="port" type="number" required defaultValue={8080} className={`${inputClass()} w-24`} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Username</label>
              <input name="username" className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Password</label>
              <input name="password" className={inputClass()} />
            </div>
            <button className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">
              <Plus size={16} /> Tambah
            </button>
          </Form>

          {proxies.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              Belum ada proxy. Tambahkan di atas atau pakai tab Bulk Import.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                    <th className="py-3 pr-4">Protocol</th>
                    <th className="py-3 pr-4">Host</th>
                    <th className="py-3 pr-4">Port</th>
                    <th className="py-3 pr-4">User</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {proxies.map((p) => (
                    <ProxyRowItem
                      key={p.id}
                      proxy={p}
                      editing={editing === p.id}
                      onToggleEdit={() => setEditing(editing === p.id ? null : p.id)}
                      testResult={testResult && testResult.id === p.id ? testResult : undefined}
                      testing={fetcher.state === "submitting"}
                      fetcher={fetcher}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : tab === "import" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <Form method="post">
            <input type="hidden" name="intent" value="import" />
            <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
              Satu proxy per baris (<code>host:port</code>, <code>host:port:user:pass</code>,{" "}
              <code>protocol://user:pass@host:port</code>) atau JSON array.
            </label>
            <textarea
              name="text"
              rows={10}
              placeholder={"1.2.3.4:8080\n5.6.7.8:3128:user:pass\nsocks5://user:pass@10.0.0.1:1080"}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
            <div className="mt-3 flex items-center gap-3">
              <button className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
                <Upload size={16} /> Import
              </button>
              {importSummary ? (
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {importSummary.imported} imported, {importSummary.skipped.length} skipped
                  {importSummary.skipped.length > 0 ? (
                    <span className="mt-1 block text-xs text-gray-400">
                      {importSummary.skipped.join("; ")}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
          </Form>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <Form method="post" className="mb-4">
            <input type="hidden" name="intent" value="assign" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Providers</p>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  {providers.map((pr) => (
                    <div key={pr.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        name="provider_id"
                        value={pr.id}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      {pr.id} <span className="text-gray-400">{pr.name}</span>
                    </div>
                  ))}
                  {providers.length === 0 ? (
                    <p className="text-xs text-gray-400">Belum ada provider.</p>
                  ) : null}
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Proxies</p>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  {proxies.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        name="proxy_id"
                        value={p.id}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      {p.protocol}://{p.host}:{p.port}
                    </div>
                  ))}
                  {proxies.length === 0 ? (
                    <p className="text-xs text-gray-400">Belum ada proxy.</p>
                  ) : null}
                </div>
              </div>
            </div>
            <button
              type="submit"
              disabled={providers.length === 0 || proxies.length === 0}
              className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Assign ke provider
            </button>
          </Form>
          <p className="mb-2 mt-6 text-sm font-semibold text-gray-900 dark:text-white">
            Assignment saat ini
          </p>
          <div className="table-wrap">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                  <th className="py-3 pr-4">Provider</th>
                  <th className="py-3 pr-4">Proxy</th>
                  <th className="py-3">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={`${a.provider_id}-${a.proxy_id}`} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">
                      {a.provider_name} <span className="text-gray-400">({a.provider_id})</span>
                    </td>
                    <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">
                      {a.protocol}://{a.host}:{a.port}
                    </td>
                    <td className="py-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="unassign" />
                        <input type="hidden" name="provider_id" value={a.provider_id} />
                        <input type="hidden" name="proxy_id" value={a.proxy_id} />
                        <button className="flex items-center gap-1 text-sm text-red-500 hover:underline dark:text-red-400">
                          <Trash2 size={14} /> Hapus
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
                {assignments.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-6 text-center text-gray-400">
                      Belum ada assignment.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ProxyRowItem({
  proxy,
  editing,
  onToggleEdit,
  testResult,
  testing,
  fetcher,
}: {
  proxy: ProxyRow;
  editing: boolean;
  onToggleEdit: () => void;
  testResult?: { id: number; ok: boolean; message: string };
  testing: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <tr className="border-b border-gray-100 dark:border-gray-800">
      {editing ? (
        <td colSpan={6} className="bg-gray-50 py-3 dark:bg-gray-900/50">
          <Form method="post" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="id" value={proxy.id} />
            <select name="protocol" defaultValue={proxy.protocol} className={inputClass() + " w-28"}>
              <option value="http">http</option>
              <option value="socks5">socks5</option>
            </select>
            <input name="host" defaultValue={proxy.host} className={`${inputClass()} w-44`} />
            <input name="port" type="number" defaultValue={proxy.port} className={`${inputClass()} w-20`} />
            <input name="username" defaultValue={proxy.username ?? ""} placeholder="user" className={`${inputClass()} w-28`} />
            <input name="password" defaultValue={proxy.password ?? ""} placeholder="pass" className={`${inputClass()} w-28`} />
            <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white">Simpan</button>
            <button type="button" onClick={onToggleEdit} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300">Batal</button>
          </Form>
        </td>
      ) : (
        <>
          <td className="py-2 pr-4">
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {proxy.protocol}
            </span>
          </td>
          <td className="py-2 pr-4 font-mono text-sm text-gray-900 dark:text-white">{proxy.host}</td>
          <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">{proxy.port}</td>
          <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{proxy.username ?? "-"}</td>
          <td className="py-2 pr-4">
            <Form method="post">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="id" value={proxy.id} />
              <input type="hidden" name="is_active" value={proxy.is_active ? 0 : 1} />
              <button
                className={`rounded-full px-2 py-0.5 text-xs ${
                  proxy.is_active
                    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                    : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                }`}
              >
                {proxy.is_active ? "on" : "off"}
              </button>
            </Form>
          </td>
          <td className="py-2">
            <div className="flex items-center gap-2">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="test" />
                <input type="hidden" name="id" value={proxy.id} />
                <button type="submit" disabled={testing} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
                  Test
                </button>
              </fetcher.Form>
              {testResult ? (
                <span
                  className={`text-xs ${testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                  title={testResult.message}
                >
                  {testResult.ok ? "OK" : "Gagal"}
                </span>
              ) : null}
              <button type="button" onClick={onToggleEdit} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
                Edit
              </button>
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="id" value={proxy.id} />
                <button className="text-red-600 hover:underline dark:text-red-400" title="Hapus proxy">
                  <Trash2 size={14} />
                </button>
              </Form>
            </div>
          </td>
        </>
      )}
    </tr>
  );
}
```

> Catatan Bulk Assignment: satu `<Form>` berisi checkbox `name="provider_id"` (pilih **satu** provider; `form.get` mengambil yang pertama) dan `name="proxy_id"` (boleh banyak). Form submit → `assignProxies(providerId, ids)` memasang banyak proxy sekaligus ke provider pilihan.

- [ ] **Step 3: Jalankan regresi + typecheck**

Run: `npm test && npm run typecheck && npm run build`
Expected: semuanya pass.

- [ ] **Step 4: Uji manual UI**

Bila server dev jalan (`bun run dev`), verifikasi:
1. `/proxies` muncul di sidebar.
2. Tab Daftar Proxy: tambah `localhost:8080`, toggle on/off, Edit, Hapus, Test.
3. Tab Bulk Import: paste 3 baris (valid, invalid, duplicate) → ringkasan benar.
4. Tab Bulk Assignment: assign 1 proxy ke provider `dahl`, lihat tabel.
5. Uji chat E2E lewat `scripts/mock-upstream.ts` (bila tersedia) dengan proxy lokal → stream sukses lewat proxy.

- [ ] **Step 5: Commit**

```bash
git add app/routes/proxies.tsx app/components/sidebar.tsx
git commit -m "feat: add proxies admin page with bulk import and assignment"
```

---

### Task 9: Verifikasi akhir

**Files:** (no new code)

- [ ] **Step 1: Regresi penuh**

Run: `npm test`
Expected: semua pass (sebelumnya 77; sekarang ≈ 100+).

Run: `npm run typecheck`
Expected: no errors.

Run: `npm run build`
Expected: build sukses.

- [ ] **Step 2: Jalankan server + sanity**

Run: `bun server.ts` (atau `npm run dev`) dan:
1. `/proxies` → tambah proxy lokal (mis. `127.0.0.1:8080`).
2. Assign ke provider lalu cek test provider di `/providers` tetap berfungsi.
3. Request chat sederhana (`stream=false`) ke route `v1/chat/completions` dengan sesi admin; pastikan tak ada regression error.

- [ ] **Step 3: Periksa `git log --oneline -15`**

Pastikan deretan commit antar-tugas rapi dan hanya berisi task-task fitur proxy.

---

## Self-Review (checklist yang dijalankan sebelum handoff)

1. **Spec coverage:** §1 data model → Task 1. §2 resolusi/transport → Task 3 (+parse Task 2). §3 eksekusi → Task 4. §4 chat route → Task 5. §5 UI `/proxies` → Task 8. §6 proxy per API key → Task 6 (dengan koreksi penempatan: `providers.$id.tsx`). §7 test koneksi & modelsUrl → Task 7 (+test-key Task 6). §8 error handling (message `proxy connect failed`, auth 401/407 non-retryable, `status: error`) → Task 4. §9 pengujian → tiap task + Task 9.
2. **Placeholder scan:** tidak ada "TBD"/"handle edge cases"; tiap langkah punya kode konkret.
3. **Type consistency:** `ProxyConfig`/`ProxyInput`/`ProxyRow` konsisten antar task; `resolveProxyCandidates`, `resolveProxy`, `resolveProxyForKey`, `fetchUpstream`, `formatProxy` dipakai dengan nama sama di semua task; `ExecutorOptions.proxies` konsisten antara Task 4 dan Task 5.
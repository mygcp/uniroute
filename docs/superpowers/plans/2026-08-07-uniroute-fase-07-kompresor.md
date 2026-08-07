# Fase 7 — Kompresor RTK + Caveman

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development atau executing-plans. Steps use checkbox syntax.

**Tujuan:** Menambahkan pipeline kompresi prompt dengan subprocess `Bun.spawn()` — RTK → Caveman (PRD §12). Semua error/timeout/binary missing → fallback aman ke prompt asli + log warning. Terintegrasi ke translate stage.

**Deliverable:** `compressor.ts` dengan `compress(prompt)` dan `test(prompt)`, toggle/konfig dari DB `compression_settings`, tombol Test di `/compression` berfungsi.

**Sumber:** PRD §12, §13 (kompresi), Catatan: biner tidak tersedia → uji jalur fallback.

---

## Task 7.1 — Compressor module

**Files:**
- Create: `app/.server/compressor.ts`

**Interfaces:**
- Consumes: `db` (compression_settings), `proxyLog` (Fase 6.1).
- Produces: `isEnabled(): { rtk: boolean; caveman: boolean }`, `compress(prompt: string): Promise<{ output: string; usedFallback: boolean; durationMs: number }>`, `testCompression(sample: string): Promise<CompressionResult>`.

- [ ] **Step 1: Baca setting**

```ts
export function isEnabled() {
  const row = db.query(`SELECT rtk_enabled, caveman_enabled FROM compression_settings WHERE id = 1`).get();
  return { rtk: !!row?.rtk_enabled, caveman: !!row?.caveman_enabled };
}
```

- [ ] **Step 2: Helper spawn satu subprocess dengan timeout 5s**

```ts
import { spawn } from "bun";
import { resolve } from "node:path";

async function runBinary(binPath: string, input: string): Promise<string> {
  const proc = spawn({ cmd: [binPath], stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000));
  try {
    const [stdout] = await Promise.race([
      processStdout(proc, input),
      timeout,
    ]);
    return stdout;
  } finally {
    proc.kill();
  }
}
```

- [ ] **Step 3: Pipeline = RTK → Caveman bila keduanya enabled**

```ts
export async function compress(prompt: string): Promise<{ output: string; usedFallback: boolean; durationMs: number }> {
  const { rtk, caveman } = isEnabled();
  const start = Date.now();
  if (!rtk && !caveman) {
    return { output: prompt, usedFallback: false, durationMs: 0 };
  }
  try {
    let out = prompt;
    if (rtk) {
      const settings = db.query(`SELECT rtk_binary_path FROM compression_settings WHERE id=1`).get();
      out = await runBinary(resolve(settings.rtk_binary_path), out);
    }
    if (caveman) {
      const settings = db.query(`SELECT caveman_binary_path FROM compression_settings WHERE id=1`).get();
      out = await runBinary(resolve(settings.caveman_binary_path), out);
    }
    return { output: out, usedFallback: false, durationMs: Date.now() - start };
  } catch (err) {
    proxyLog("warn", "compressor", `compression failed, fallback to original prompt`, { error: String(err) });
    return { output: prompt, usedFallback: true, durationMs: Date.now() - start };
  }
}
```

> **Fallback aman:** binary tidak ada / timeout / exit non-zero → prompt asli + `proxyLog` warning. Bukan error fatal ke user.

- [ ] **Step 4: `testCompression`**

Sama seperti `compress` tapi selalu menjalankan walaupun non-enabled (untuk tombol Test di UI). Return realisasi + hasil.

- [ ] **Step 5: Test TDD**

- `isEnabled` dengan setting default (0,0) → `{rtk: false, caveman: false}`.

- Binary dummy: buat `bin/rtk` (shebang `#!/bin/sh\ncat`) dan `bin/caveman` (sama). Enable setting → `compress("halo")` → `output:"halo"`, `usedFallback:false`.

- Binary tidak ada (rename) → `usedFallback: true`, warning tercatat.
- Timeout: binary `sleep 10` → timeout 5s → fallback.
- Nonaktif → langsung return asli tanpa spawn.

- [ ] **Step 6: Verifikasi**

```bash
bun test app/.server/compressor.test.ts
```

Expected: PASS.

---

## Task 7.2 — Integrasi translate stage + path binary

**Files:**
- Modify: `app/routes/v1.chat.completions.ts` (translate stage)
- Modify: `app/routes/compression.tsx` (test button Fase 5.3 wired)

- [ ] **Step 1: Integrasi ke pipeline**

Di stage Translate (setelah transformRequest, sebelum fetch):

```ts
if (isEnabled().rtk || isEnabled().caveman) {
  const body = JSON.parse(bodyText);
  const lastMessage = body.messages.at(-1)?.content ?? "";
  if (typeof lastMessage === "string") {
    const { output } = await compress(lastMessage);
    body.messages[body.messages.length - 1].content = output;
    bodyText = JSON.stringify(body);
  }
}
```

> PRD kompresi target `prompt` — kompresi diterapkan pada pesan user terakhir. `usedFallback` & durasi dapat dicatat; cache hasil per-prompt (Map) untuk menghindari spawn berulang pada request yang sama.

- [ ] **Step 2: Compression page Test button → `testCompression`**

`compression.tsx` action POST → hasil `testCompression("Contoh prompt...")` via route action → tampil output + `usedFallback` + duration.

- [ ] **Step 3: Paste seeding**

Pastikan setting `compression_settings` row id=1 ada (default 0) — seeded di Fase 1.

---

## Checkpoint Fase 7

- [ ] `bun test app/.server/compressor.test.ts` PASS.
- [ ] Pipeline RTK→Caveman berjalan (dengan binary dummy).
- [ ] Binary tidak ada / timeout → fallback prompt asli + `proxy_logs` warning.
- [ ] `/compression` tombol Test menampilkan hasil + fallback status.
- [ ] Commit: `feat: compression pipeline rtk+caveman`
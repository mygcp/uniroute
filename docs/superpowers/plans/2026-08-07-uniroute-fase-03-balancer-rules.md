# Fase 3 — Load Balancer + Rule Engine

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development atau executing-plans. Steps use checkbox syntax.

**Tujuan:** Menambahkan 6 strategy load balancing (PRD §9) dan rule engine (PRD §10.2) ke pipeline. Mengganti "pick pertama" di Fase 2 menjadi pemilihan provider via balancer + fallback antar provider.

**Deliverable:** Balancer dengan 6 strategy yang thread-safe, guard + rules terintegrasi, log `strategy_used` & `rule_applied` tercatat.

**Sumber:** PRD §9 (load balancing), §10.2 (routing rules), §13 (DoD).

---

## Task 3.1 — Balancer: 6 strategy

**Files:**
- Create: `app/.server/balancer.ts`

**Interfaces:**
- Consumes: `Provider` (Fase 2.1), `db` (Fase 1).
- Produces: `selectProvider(pool: Provider[], model: string): Promise<Provider | null>`, `getStrategy(model: string): string`, `beginConnection(providerId)`, `endConnection(providerId)`.

- [ ] **Step 1: Baca konfigurasi strategy per model dari `load_balancing`**

```ts
export function getStrategy(model: string): { strategy: string; fallbackEnabled: boolean; healthCheck: { enabled: boolean; url?: string; interval: number } } {
  const row = db.query(`SELECT * FROM load_balancing WHERE model_name = ?`).get(model);
  if (!row) return { strategy: "round_robin", fallbackEnabled: true, health: { enabled: false, interval: 60 } };
  return { strategy: row.strategy, fallbackEnabled: !!row.fallback_enabled, health: {...} };
}
```

- [ ] **Step 2: `select` — implementasi 6 strategy**

```ts
export function selectProvider(pool: Provider[], model: string): Provider | undefined {
  const cfg = getStrategy(model);
  switch (cfg.strategy) {
    case "round_robin": return roundRobin(pool);       // pilih last_used_at terlama
    case "random":      return randomPick(pool);
    case "priority":    return priorityPick(pool);      // priority tertinggi; bila gagal next
    case "weighted":    return weightedPick(pool);      // probabilitas prop. weight
    case "least_conn":  return leastConn(pool);          // current_connections terendah
    case "first_available": return firstAvailable(pool, cfg.health); // aktif + healthy
    default: return roundRobin(pool);
  }
}
```

**Round Robin (helper):** urutkan pool by `last_used_at` ascending, pilih pertama. Setelah pakai, update `last_used_at`.

**Weighted (helper):** total `weight`; pilih index via kumulatif random.

**LeastConn (helper):** order by `current_connections` asc.

**FirstAvailable:** bila `health.enabled`, cek cache health (in-memory map `providerId → lastCheck{ok,ts}`); pilih yang healthy & aktif.

- [ ] **Step 3: `beginConnection` / `endConnection` — thread-safe counter**

```ts
export function beginConnection(providerId: string) {
  db.run("UPDATE providers SET current_connections = current_connections + 1 WHERE id = ?", [providerId]);
}
export function endConnection(providerId: string) {
  db.run("UPDATE providers SET current_connections = MAX(0, current_connections - 1) WHERE id = ?", [providerId]);
}
```

> Di Bun (single-thread event loop) counter DB `UPDATE` berbasis SQL aman untuk kompetisi antar-request async.

- [ ] **Step 4: TDD — test `balancer.test.ts`**

Test untuk tiap strategy dengan fixture pool:

```
Provider A: weight 3, priority 2, current_connections 5
Provider B: weight 1, priority 1, current_connections 1
Provider C: weight 2, priority 0, current_connections 3
```

- `round_robin`: pilih last_used_at terlama, berurutan A→B→C.
- `random`: 500 iterasi → hasil keduanya timbul.
- `priority`: selalu A (priority tertinggi).
- `weighted`: 1000 iterasi → A ~50%, B ~16.7%, C ~33.3% (toleransi ±5%).
- `least_conn`: selalu B (1 koneksi).
- `first_available`: dengan health cache hasil healthy → pertama; fatal semua → null.

- [ ] **Step 5: Verifikasi**

```bash
bun test app/.server/balancer.test.ts
```

Expected: PASS.

---

## Task 3.2 — Rule Engine

**Files:**
- Create: `app/.server/rules.ts`

**Interfaces:**
- Produces: `evaluateRules(model: string): { action: "rewrite" | "deny" | "fallback" | "none"; targetModel?: string; targetProviderId?: string; ruleApplied?: string }`.

- [ ] **Step 1: Query `routing_rules` by priority**

```ts
export function evaluateRules(model: string) {
  const rows = db.query(`
    SELECT * FROM routing_rules
    WHERE source_model = ? AND is_active = 1
    ORDER BY priority DESC
  `).all(model);
  for (const rule of rows) {
    // deny: langkah pertama
    if (rule.rule_type === "deny") return { action: "deny", ruleApplied: rule.name };
    // rewrite: ganti model
    if (rule.rule_type === "rewrite") return { action: "rewrite", targetModel: rule.target_model, ruleApplied: rule.name };
    // fallback: harus menangani di balancer runtime (return informasi saja di sini)
    if (rule.rule_type === "fallback") return { action: "fallback", targetProviderId: rule.target_provider_id, ... };
  }
  return { action: "none" };
}
```

> Prioritasi deny → rewrite → fallback. Auto-resolve: karena `source_model` bisa juga hasil rewrite (rule chaining), batasi 1x rewrite untuk kesederhanaan.

- [ ] **Step 2: TDD test**

- Rule deny aktif → action deny.
- Rule rewrite → model berubah.
- Fallback terdaftar → action fallback.
- Rules dinonaktifkan (`is_active=0`) → tidak terpakai.
- Priority: screen rules dengan priority tertinggi menang.

---

## Task 3.3 — Integrasi pipeline (v1.chat.completions)

**Files:**
- Modify: `app/routes/v1.chat.completions.ts`

- [ ] **Step 1: Update alur action**

```
1. parse body
2. Guard.checkAllowlist(model) → deny → 403
3. Rules.evaluateRules(model) → mengubah:
   - deny → return 403 (dengan rule detail)
   - rewrite → set body.model = targetModel (lanjut ke route)
   - fallback → catat targetProviderId (untuk step 8)
4. pool = registry.getProviders(model)
5. provider = balancer.selectProvider(pool, model)
6. beginConnection(provider.id)
7. transformRequest + handleStreaming (Fase 2)
8. fallback: jika execute gagal & fallbackEnabled(true) → coba provider berikutnya (daftar pool kecuali sebelumnya), maksimal 1x
9. endConnection(provider.id) setelah selesai
10. Record log dengan strategy_used + rule_applied
```

- [ ] **Step 2: Update record untuk menyertakan `strategy_used` & `rule_applied`**

`recordRequestLog({... strategy_used: cfg.strategy, rule_applied: rule.ruleApplied})`.

- [ ] **Step 3: Manual E2E**

- `gpt-4o` seed round_robin: request beruntun 3x → provider berganti (openai → groq → openrouter) berdasarkan `last_used_at`.
- Deny rule pada model → 403.
- Rewrite `gpt-4o` → `llama-3.1-8b` → request diteruskan ke pool llama.

---

## Checkpoint Fase 3

- [ ] `bun test` balancer (6 strategy) + rules PASS.
- [ ] Round-robin: 3 request → 3 provider berganti.
- [ ] Deny rule → 403.
- [ ] Rewrite rule → forwarded ke model target.
- [ ] Fallback provider gagal → request sukses via provider lain (1x).
- [ ] Commit: `feat: load balancing 6 strategies + rule engine`
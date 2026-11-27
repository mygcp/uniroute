import { exec, getTableVersion, onBeforeRead, onDbReset, onShutdownFlush, query } from "./db";

/**
 * Combo Engine: model layer (`priority` fallback chain & `pipeline` sequential).
 * Pure data and static helpers for unit testing; execution lives in `combo-runner.ts`.
 */

export type ComboStrategy = "priority" | "pipeline";

export type ComboStepInput = {
  /** Specific provider ID; null/undefined matches any provider for that model. */
  providerId?: string | null;
  modelId?: string;
  modelIds?: string[];
  /** Weight reserved for weighted strategy compatibility. */
  weight?: number | null;
  /** Specific credential/account; null/undefined = auto/dynamic. */
  accountId?: number | null;
  accountIds?: number[];
  /** Step-specific prompt instruction (pipeline or system hint). */
  prompt?: string | null;
};

export type ComboStep = {
  id: number;
  comboId: number;
  stepOrder: number;
  providerId: string | null;
  modelIds: string[];
  accountId: number | null;
  accountIds: number[];
  weight: number;
  prompt: string | null;
};

export type Combo = {
  id: number;
  name: string;
  strategy: ComboStrategy;
  config: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  steps: ComboStep[];
};

export type ComboInput = {
  name: string;
  strategy: ComboStrategy;
  steps: ComboStepInput[];
  config?: Record<string, unknown>;
};

type ComboRow = {
  id: number;
  name: string;
  strategy: string;
  config: string;
  created_at: number;
  updated_at: number;
};
type StepRow = {
  id: number;
  combo_id: number;
  step_order: number;
  provider_id: string | null;
  model_id: string | null;
  model_ids: string | null;
  account_id: number | null;
  account_ids: string | null;
  weight: number;
  prompt: string | null;
};

/** Model reference from client: `combo:<name>`. */
export function parseComboModel(model: string): string | null {
  if (typeof model !== "string") return null;
  if (!model.startsWith("combo:")) return null;
  const name = model.slice("combo:".length).trim();
  return name.length > 0 ? name : null;
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Read the proxy pool assigned to a combo (`combos.config.proxy_pool_id`).
 * Returns the pool id when it is a finite number > 0, else null.
 */
export function comboProxyPoolId(
  combo: { config?: Record<string, unknown> | null } | null | undefined,
): number | null {
  const raw = combo?.config?.["proxy_pool_id"];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw.trim()) : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function parseModelIds(row: StepRow): string[] {
  if (row.model_ids) {
    try {
      const v = JSON.parse(row.model_ids) as unknown;
      if (Array.isArray(v)) {
        const list = v
          .map((m) => String(m).trim())
          .filter((m) => m.length > 0);
        if (list.length > 0) return list;
      }
    } catch {
      /* fallthrough */
    }
  }
  if (row.model_id) return [row.model_id];
  return [];
}
function parseAccountIds(row: StepRow): number[] {
  if (row.account_ids) {
    try {
      const v = JSON.parse(row.account_ids) as unknown;
      if (Array.isArray(v)) {
        const list = v.map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (list.length > 0) return list;
      }
    } catch {
      /* fallthrough */
    }
  }
  if (row.account_id != null && Number.isFinite(Number(row.account_id)) && Number(row.account_id) > 0) {
    return [Number(row.account_id)];
  }
  return [];
}
let comboCacheVer = -1;
let comboByNameCache = new Map<string, Combo>();
let comboByIdCache = new Map<number, Combo>();

const comboMetricQueue: ComboMetric[] = [];
let comboMetricTimer: ReturnType<typeof setTimeout> | null = null;

function ensureComboCache(): void {
  const ver = getTableVersion("combos") + getTableVersion("combo_steps");
  if (ver === comboCacheVer) return;
  const rows = (
    query("SELECT id, name, strategy, config, created_at, updated_at FROM combos ORDER BY name ASC").all() as unknown as ComboRow[]
  ) ?? [];
  const stepRows = (
    query(
      `SELECT id, combo_id, step_order, provider_id, model_id, model_ids, account_id, account_ids, weight, prompt
       FROM combo_steps ORDER BY combo_id ASC, step_order ASC, id ASC`,
    ).all() as unknown as StepRow[]
  ) ?? [];
  const stepsByCombo = new Map<number, ComboStep[]>();
  for (const r of stepRows) {
    let arr = stepsByCombo.get(r.combo_id);
    if (!arr) {
      arr = [];
      stepsByCombo.set(r.combo_id, arr);
    }
    arr.push({
      id: r.id,
      comboId: r.combo_id,
      stepOrder: r.step_order,
      providerId: r.provider_id ?? null,
      modelIds: parseModelIds(r),
      accountId: r.account_id ?? null,
      accountIds: parseAccountIds(r),
      weight: r.weight ?? 1,
      prompt: r.prompt ?? null,
    });
  }
  const nextByName = new Map<string, Combo>();
  const nextById = new Map<number, Combo>();
  for (const r of rows) {
    const c: Combo = {
      id: r.id,
      name: r.name,
      strategy: r.strategy === "pipeline" ? "pipeline" : "priority",
      config: parseConfig(r.config),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      steps: stepsByCombo.get(r.id) ?? [],
    };
    nextByName.set(c.name, c);
    nextById.set(c.id, c);
  }
  comboByNameCache = nextByName;
  comboByIdCache = nextById;
  comboCacheVer = ver;
}

export function flushComboMetrics(): void {
  if (comboMetricTimer) {
    clearTimeout(comboMetricTimer);
    comboMetricTimer = null;
  }
  if (comboMetricQueue.length === 0) return;
  const items = comboMetricQueue.splice(0);
  exec("BEGIN");
  try {
    const stmt = query(
      `INSERT INTO combo_metrics
         (combo_id, combo_name, strategy, step_index, model_id, provider_id, latency_ms, cost, success, tokens_used, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const m of items) {
      stmt.run(
        m.comboId,
        m.comboName,
        m.strategy,
        m.stepIndex,
        m.modelId,
        m.providerId ?? null,
        m.latencyMs ?? null,
        m.cost ?? null,
        m.success ? 1 : 0,
        m.tokensUsed ?? null,
        m.error ?? null,
      );
    }
    exec("COMMIT");
  } catch (err) {
    exec("ROLLBACK");
    throw err;
  }
}

onBeforeRead("combo_metrics", flushComboMetrics);
onShutdownFlush(flushComboMetrics);
onDbReset(() => {
  comboCacheVer = -1;
  comboByNameCache.clear();
  comboByIdCache.clear();
  comboMetricQueue.length = 0;
  if (comboMetricTimer) {
    clearTimeout(comboMetricTimer);
    comboMetricTimer = null;
  }
});

export function listCombos(): Combo[] {
  ensureComboCache();
  return [...comboByNameCache.values()];
}

export function getComboByName(name: string): Combo | undefined {
  if (!name) return undefined;
  ensureComboCache();
  return comboByNameCache.get(name);
}

export function getComboById(id: number): Combo | undefined {
  ensureComboCache();
  return comboByIdCache.get(id);
}

/** Resolve model name to combo (`combo:` prefix only, no conflict with real models). */
export function resolveCombo(model: string): Combo | undefined {
  const name = parseComboModel(model);
  return name ? getComboByName(name) : undefined;
}

/** Validate combo input; returns error message or null if valid. */
export function validateComboInput(input: ComboInput): string | null {
  const name = (input.name ?? "").trim();
  if (!name) return "combo name is required";
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    return "combo name may only contain letters, numbers, . _ -";
  }
  if (input.strategy !== "priority" && input.strategy !== "pipeline") {
    return "strategy must be priority or pipeline";
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    return "combo needs at least one step";
  }
  for (let i = 0; i < input.steps.length; i += 1) {
    const step = input.steps[i];
    if (!step || typeof step !== "object") return `step ${i + 1} is invalid`;
    const modelIds = (step.modelIds?.length ? step.modelIds : step.modelId ? [step.modelId] : []) ?? [];
    const clean = modelIds.map((m) => String(m).trim()).filter((m) => m.length > 0);
    if (clean.length === 0) return `step ${i + 1} requires at least one model`;
    for (const m of clean) {
      if (m.startsWith("combo:")) {
        return `step ${i + 1}: nested combo reference is not supported yet`;
      }
    }
  }
  return null;
}

export function createCombo(input: ComboInput): Combo {
  const name = input.name.trim();
  const existing = getComboByName(name);
  if (existing) throw new Error(`combo "${name}" already exists`);
  const strategy = input.strategy === "pipeline" ? "pipeline" : "priority";
  const config = JSON.stringify(input.config && typeof input.config === "object" ? input.config : {});
  const now = Math.floor(Date.now() / 1000);
  exec("BEGIN");
  try {
    query(
      "INSERT INTO combos (name, strategy, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run(name, strategy, config, now, now);
    const row = query(
      "SELECT id FROM combos WHERE name = ?",
    ).get(name) as { id: number };
    insertSteps(row.id, input.steps);
    exec("COMMIT");
  } catch (err) {
    exec("ROLLBACK");
    throw err;
  }
  return getComboByName(name)!;
}

function insertSteps(comboId: number, steps: ComboStepInput[]): void {
  const insert = query(
    `INSERT INTO combo_steps (combo_id, step_order, provider_id, model_id, model_ids, account_id, account_ids, weight, prompt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  steps.forEach((step, index) => {
    const providerId = (step.providerId ?? "").trim();
    const modelIds = ((step.modelIds?.length ? step.modelIds : step.modelId ? [step.modelId] : []) ?? [])
      .map((m) => String(m).trim())
      .filter((m) => m.length > 0);
    const accountIds = (
      Array.isArray(step.accountIds)
        ? step.accountIds
        : step.accountId && Number.isFinite(Number(step.accountId))
          ? [Number(step.accountId)]
          : []
    )
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    insert.run(
      comboId,
      index + 1,
      providerId || null,
      modelIds[0] ?? null,
      modelIds.length > 0 ? JSON.stringify(modelIds) : null,
      accountIds[0] ?? null,
      accountIds.length > 0 ? JSON.stringify(accountIds) : null,
      Number.isFinite(Number(step.weight)) && Number(step.weight) > 0 ? Number(step.weight) : 1,
      (step.prompt ?? "").trim() || null,
    );
  });
}

/** Replace all steps and base fields for combo ID. */
export function updateCombo(id: number, input: ComboInput): Combo | undefined {
  const existing = getComboById(id);
  if (!existing) return undefined;
  if (existing.name !== input.name.trim() && getComboByName(input.name.trim())) {
    throw new Error(`combo "${input.name.trim()}" already exists`);
  }
  const now = Math.floor(Date.now() / 1000);
  const merged = { ...(existing.config ?? {}), ...(input.config ?? {}) };
  exec("BEGIN");
  try {
    query("UPDATE combos SET name = ?, strategy = ?, config = ?, updated_at = ? WHERE id = ?").run(
      input.name.trim(),
      input.strategy === "pipeline" ? "pipeline" : "priority",
      JSON.stringify(merged),
      now,
      id,
    );
    query("DELETE FROM combo_steps WHERE combo_id = ?").run(id);
    insertSteps(id, input.steps);
    exec("COMMIT");
  } catch (err) {
    exec("ROLLBACK");
    throw err;
  }
  return getComboById(id);
}

export function deleteCombo(id: number): void {
  query("DELETE FROM combos WHERE id = ?").run(id);
}

export type ComboMetric = {
  comboId: number;
  comboName: string;
  strategy: ComboStrategy;
  stepIndex: number;
  modelId: string;
  providerId: string | null;
  latencyMs?: number | null;
  cost?: number | null;
  success: boolean;
  tokensUsed?: number | null;
  error?: string | null;
};

export function recordComboMetric(m: ComboMetric): void {
  if (comboMetricQueue.length >= 5000) {
    comboMetricQueue.shift();
  }
  comboMetricQueue.push(m);
  if (comboMetricQueue.length >= 64) {
    flushComboMetrics();
    return;
  }
  if (!comboMetricTimer) {
    comboMetricTimer = setTimeout(flushComboMetrics, 50);
    comboMetricTimer.unref?.();
  }
}

export function listComboMetrics(comboId: number, limit = 100): {
  id: number;
  comboId: number;
  comboName: string | null;
  strategy: string | null;
  stepIndex: number | null;
  modelId: string | null;
  providerId: string | null;
  timestamp: number;
  latencyMs: number | null;
  cost: number | null;
  success: number;
  tokensUsed: number | null;
  error: string | null;
}[] {
  flushComboMetrics();
  return (
    query(
      `SELECT id, combo_id, combo_name, strategy, step_index, model_id, provider_id,
              timestamp, latency_ms, cost, success, tokens_used, error
       FROM combo_metrics WHERE combo_id = ?
       ORDER BY timestamp DESC, id DESC LIMIT ?`,
    ).all(comboId, limit) as unknown as {
      id: number;
      combo_id: number;
      combo_name: string | null;
      strategy: string | null;
      step_index: number | null;
      model_id: string | null;
      provider_id: string | null;
      timestamp: number;
      latency_ms: number | null;
      cost: number | null;
      success: number;
      tokens_used: number | null;
      error: string | null;
    }[]
  ).map((r) => ({
    id: r.id,
    comboId: r.combo_id,
    comboName: r.combo_name,
    strategy: r.strategy,
    stepIndex: r.step_index,
    modelId: r.model_id,
    providerId: r.provider_id,
    timestamp: r.timestamp,
    latencyMs: r.latency_ms,
    cost: r.cost,
    success: r.success,
    tokensUsed: r.tokens_used,
    error: r.error,
  }));
}

/**
 * Extract primary text from upstream response for pipeline chaining
 * (supports OpenAI chat, OpenAI Responses, Anthropic, and Gemini).
 */
export function extractUpstreamText(json: unknown): string {
  if (json === null || typeof json !== "object") return "";
  const record = json as Record<string, unknown>;

  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0] as Record<string, unknown> | undefined;
    if (choice) {
      const message = choice.message as Record<string, unknown> | undefined;
      if (message && typeof message.content === "string") return message.content;
      if (typeof choice.text === "string") return choice.text;
      const delta = choice.delta as Record<string, unknown> | undefined;
      if (delta && typeof delta.content === "string") return delta.content;
    }
  }

  const content = record.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const raw of content) {
      const part = raw as Record<string, unknown> | undefined;
      if (!part) continue;
      if (typeof part.text === "string") parts.push(part.text);
      else if (part.type === "text" && typeof part.content === "string") parts.push(part.content);
      else if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    }
    return parts.join("\n");
  }

  const output = record.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const raw of output) {
      const item = raw as Record<string, unknown> | undefined;
      if (!item) continue;
      if (typeof item.text === "string") parts.push(item.text);
      if (Array.isArray(item.content)) {
        for (const c of item.content) {
          const part = c as Record<string, unknown> | undefined;
          if (part && typeof part.text === "string") parts.push(part.text);
        }
      }
    }
    return parts.join("\n");
  }

  const candidates = record.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0] as Record<string, unknown> | undefined;
    const contentParts = first?.content;
    const partsList = Array.isArray(contentParts)
      ? contentParts
      : contentParts && typeof contentParts === "object"
        ? ((contentParts as Record<string, unknown>).parts as unknown[] | undefined)
        : undefined;
    if (Array.isArray(partsList)) {
      const parts: string[] = [];
      for (const raw of partsList) {
        const p = raw as Record<string, unknown> | undefined;
        if (p && typeof p.text === "string") parts.push(p.text);
      }
      return parts.join("\n");
    }
  }

  return "";
}
import { query } from "./db";

/**
 * Combo Engine — model layer (MVP: `priority` fallback chain & `pipeline`
 * sequential). Data murni + helper statis agar mudah di-unit-test.
 * Eksekusi request ada di `combo-runner.ts`.
 */

export type ComboStrategy = "priority" | "pipeline";

export type ComboStepInput = {
  /** Provider id spesifik; null/undefined = semua provider untuk model itu. */
  providerId?: string | null;
  modelId: string;
  /** Bobot untuk strategi weighted (cadangan, disimpan untuk kompatibilitas). */
  weight?: number | null;
  /** Instruksi khusus step (dipakai pipeline / ditambahkan sebagai system hint). */
  prompt?: string | null;
};

export type ComboStep = {
  id: number;
  comboId: number;
  stepOrder: number;
  providerId: string | null;
  modelId: string;
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
  model_id: string;
  weight: number;
  prompt: string | null;
};

/** Model reference dari client: `combo:<nama>`. */
export function parseComboModel(model: string): string | null {
  if (typeof model !== "string") return null;
  if (!model.startsWith("combo:")) return null;
  const name = model.slice("combo:".length).trim();
  return name.length > 0 ? name : null;
}

export function isComboModel(model: string): boolean {
  return parseComboModel(model) !== null;
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stepsFor(comboId: number): ComboStep[] {
  const rows = (
    query(
      `SELECT id, combo_id, step_order, provider_id, model_id, weight, prompt
       FROM combo_steps WHERE combo_id = ? ORDER BY step_order ASC, id ASC`,
    ).all(comboId) as unknown as StepRow[]
  ) ?? [];
  return rows.map((r) => ({
    id: r.id,
    comboId: r.combo_id,
    stepOrder: r.step_order,
    providerId: r.provider_id ?? null,
    modelId: r.model_id,
    weight: r.weight ?? 1,
    prompt: r.prompt ?? null,
  }));
}

function rowToCombo(row: ComboRow): Combo {
  return {
    id: row.id,
    name: row.name,
    strategy: row.strategy === "pipeline" ? "pipeline" : "priority",
    config: parseConfig(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    steps: stepsFor(row.id),
  };
}

export function listCombos(): Combo[] {
  const rows = (
    query("SELECT id, name, strategy, config, created_at, updated_at FROM combos ORDER BY name ASC").all() as unknown as ComboRow[]
  ) ?? [];
  return rows.map(rowToCombo);
}

export function getComboByName(name: string): Combo | undefined {
  if (!name) return undefined;
  const row = query(
    "SELECT id, name, strategy, config, created_at, updated_at FROM combos WHERE name = ?",
  ).get(name) as ComboRow | undefined;
  return row ? rowToCombo(row) : undefined;
}

export function getComboById(id: number): Combo | undefined {
  const row = query(
    "SELECT id, name, strategy, config, created_at, updated_at FROM combos WHERE id = ?",
  ).get(id) as ComboRow | undefined;
  return row ? rowToCombo(row) : undefined;
}

/** Resolve model name → combo (hanya `combo:` prefix; tanpa bentrok dgn model asli). */
export function resolveCombo(model: string): Combo | undefined {
  const name = parseComboModel(model);
  return name ? getComboByName(name) : undefined;
}

/** Validasi input; return pesan error atau null bila valid. */
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
    const modelId = (step.modelId ?? "").trim();
    if (!modelId) return `step ${i + 1} requires a model`;
    if (modelId.startsWith("combo:")) {
      return `step ${i + 1}: nested combo reference is not supported yet`;
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
  query(
    "INSERT INTO combos (name, strategy, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run(name, strategy, config, now, now);
  const row = query(
    "SELECT id, name, strategy, config, created_at, updated_at FROM combos WHERE name = ?",
  ).get(name) as ComboRow;
  insertSteps(row.id, input.steps);
  return rowToCombo(row);
}

function insertSteps(comboId: number, steps: ComboStepInput[]): void {
  const insert = query(
    `INSERT INTO combo_steps (combo_id, step_order, provider_id, model_id, weight, prompt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  steps.forEach((step, index) => {
    const modelId = (step.modelId ?? "").trim();
    const providerId = (step.providerId ?? "").trim();
    insert.run(
      comboId,
      index + 1,
      providerId || null,
      modelId,
      Number.isFinite(Number(step.weight)) && Number(step.weight) > 0 ? Number(step.weight) : 1,
      (step.prompt ?? "").trim() || null,
    );
  });
}

/** Replace seluruh steps (dan field dasar) untuk combo id. */
export function updateCombo(id: number, input: ComboInput): Combo | undefined {
  const existing = getComboById(id);
  if (!existing) return undefined;
  if (existing.name !== input.name.trim() && getComboByName(input.name.trim())) {
    throw new Error(`combo "${input.name.trim()}" already exists`);
  }
  const now = Math.floor(Date.now() / 1000);
  query("UPDATE combos SET name = ?, strategy = ?, config = ?, updated_at = ? WHERE id = ?").run(
    input.name.trim(),
    input.strategy === "pipeline" ? "pipeline" : "priority",
    JSON.stringify(input.config && typeof input.config === "object" ? input.config : {}),
    now,
    id,
  );
  query("DELETE FROM combo_steps WHERE combo_id = ?").run(id);
  insertSteps(id, input.steps);
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
  query(
    `INSERT INTO combo_metrics
       (combo_id, combo_name, strategy, step_index, model_id, provider_id, latency_ms, cost, success, tokens_used, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
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
 * Ekstrak teks utama dari respons upstream (untuk pipeline chaining).
 * Mendukung bentuk OpenAI chat, OpenAI Responses, Anthropic, dan Gemini.
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
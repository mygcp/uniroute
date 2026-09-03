import "./test-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";
import { query } from "./db";
import {
  comboProxyPoolId,
  createCombo,
  deleteCombo,
  extractUpstreamText,
  getComboById,
  getComboByName,
  listCombos,
  listComboMetrics,
  parseComboModel,
  recordComboMetric,
  resolveCombo,
  updateCombo,
  validateComboInput,
  type ComboInput,
} from "./combo";

beforeAll(async () => {
  await resetTestDb();
});
afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

const validInput = (overrides: Partial<ComboInput> = {}): ComboInput => ({
  name: "coding-fallback",
  strategy: "priority",
  steps: [
    { providerId: "openai", modelIds: ["gpt-4o-mini", "gpt-4o"] },
    { modelIds: ["claude-haiku"], prompt: "rapikan jawaban" },
  ],
  ...overrides,
});

describe("parseComboModel", () => {
  test("parses combo: prefix", () => {
    expect(parseComboModel("combo:foo")).toBe("foo");
    expect(parseComboModel("combo: my combo ")).toBe("my combo");
  });
  test("rejects non-combo models & empty names", () => {
    expect(parseComboModel("gpt-4o")).toBeNull();
    expect(parseComboModel("combo:")).toBeNull();
    expect(parseComboModel("")).toBeNull();
    expect(parseComboModel("combo:  ")).toBeNull();
  });
});

describe("validateComboInput", () => {
  test("accepts valid input", () => {
    expect(validateComboInput(validInput())).toBeNull();
  });
  test("rejects missing/bad name", () => {
    expect(validateComboInput(validInput({ name: " " }))).toContain("name");
    expect(validateComboInput(validInput({ name: "combo bad!" }))).toContain("letters");
  });
  test("rejects unknown strategy", () => {
    expect(validateComboInput(validInput({ strategy: "weird" as never }))).toContain("strategy");
  });
  test("rejects empty steps & missing model", () => {
    expect(validateComboInput(validInput({ steps: [] }))).toContain("at least one");
    expect(validateComboInput(validInput({ steps: [{ modelIds: [] }] }))).toContain("model");
  });
  test("rejects nested combo reference", () => {
    expect(validateComboInput(validInput({ steps: [{ modelIds: ["combo:other"] }] }))).toContain("nested");
  });
});

describe("combo CRUD", () => {
  test("create + resolve by name", () => {
    const combo = createCombo(validInput());
    expect(combo.id).toBeGreaterThan(0);
    expect(combo.name).toBe("coding-fallback");
    expect(combo.strategy).toBe("priority");
    expect(combo.steps.map((s) => s.modelIds)).toEqual([
      ["gpt-4o-mini", "gpt-4o"],
      ["claude-haiku"],
    ]);
    expect(combo.steps[0].providerId).toBe("openai");
    expect(combo.steps[0].accountId).toBeNull();
    expect(combo.steps[1].prompt).toBe("rapikan jawaban");

    expect(getComboByName("coding-fallback")?.id).toBe(combo.id);
    expect(resolveCombo("combo:coding-fallback")?.id).toBe(combo.id);
    expect(resolveCombo("gpt-4o")).toBeUndefined();
    expect(getComboById(combo.id)?.steps.length).toBe(2);
  });

  test("duplicate name throws", () => {
    expect(() => createCombo(validInput())).toThrow(/already exists/);
  });

  test("updateCombo replaces steps & field", () => {
    const combo = getComboByName("coding-fallback")!;
    const updated = updateCombo(combo.id, {
      name: combo.name,
      strategy: "pipeline",
      steps: [{ modelIds: ["gemini-pro"] }],
    });
    expect(updated?.strategy).toBe("pipeline");
    expect(updated?.steps).toHaveLength(1);
    expect(updated?.steps[0].modelIds).toEqual(["gemini-pro"]);
  });

  test("step keeps accountIds & multi-models round-trip", () => {
    const combo = createCombo({
      name: "account-step",
      strategy: "priority",
      steps: [{ providerId: "openai", modelIds: ["a", "b", "c"], accountIds: [7, 42] }],
    });
    const step = getComboById(combo.id)?.steps[0];
    expect(step?.modelIds).toEqual(["a", "b", "c"]);
    expect(step?.accountIds).toEqual([7, 42]);
  });

  test("empty accountIds stays dynamic", () => {
    const combo = createCombo({
      name: "dynamic-step",
      strategy: "priority",
      steps: [{ providerId: "openai", modelIds: ["a"] }],
    });
    expect(getComboById(combo.id)?.steps[0].accountIds).toEqual([]);
  });

  test("listCombos sorts by name", () => {
    const list = listCombos();
    expect(list.length).toBeGreaterThan(0);
    const names = list.map((c) => c.name);
    expect(names).toEqual([...names].sort());
  });

  test("deleteCombo cascades steps", () => {
    const combo = getComboByName("coding-fallback")!;
    deleteCombo(combo.id);
    expect(getComboByName("coding-fallback")).toBeUndefined();
    const steps = query("SELECT COUNT(*) AS c FROM combo_steps WHERE combo_id = ?").get(combo.id) as {
      c: number;
    };
    expect(steps.c).toBe(0);
  });
});

describe("combo_metrics", () => {
  test("record + list", () => {
    const combo = createCombo(validInput({ name: "metric-test" }));
    recordComboMetric({
      comboId: combo.id,
      comboName: combo.name,
      strategy: "priority",
      stepIndex: 0,
      modelId: "gpt-4o-mini",
      providerId: "openai",
      latencyMs: 123,
      cost: 0.00042,
      success: true,
      tokensUsed: 210,
    });
    recordComboMetric({
      comboId: combo.id,
      comboName: combo.name,
      strategy: "priority",
      stepIndex: 1,
      modelId: "claude-haiku",
      providerId: null,
      success: false,
      error: "model not found",
    });
    const metrics = listComboMetrics(combo.id);
    expect(metrics).toHaveLength(2);
    expect(metrics[1].success).toBe(1);
    expect(metrics[1].cost).toBeCloseTo(0.00042);
    expect(metrics[0].success).toBe(0);
    expect(metrics[0].error).toContain("model not found");
  });
});

describe("comboProxyPoolId", () => {
  test("reads proxy_pool_id from config", () => {
    expect(comboProxyPoolId({ config: { proxy_pool_id: 7 } })).toBe(7);
    expect(comboProxyPoolId({ config: { proxy_pool_id: "12" } })).toBe(12);
    expect(comboProxyPoolId({ config: {} })).toBeNull();
    expect(comboProxyPoolId({ config: { proxy_pool_id: null } })).toBeNull();
    expect(comboProxyPoolId({ config: { proxy_pool_id: 0 } })).toBeNull();
    expect(comboProxyPoolId(null)).toBeNull();
  });
  test("create stores pool id; update merges without wiping other keys", () => {
    const combo = createCombo(
      validInput({ name: "pool-cfg-test", config: { proxy_pool_id: 7, other: "keep" } }),
    );
    expect(comboProxyPoolId(getComboById(combo.id))).toBe(7);
    const updated = updateCombo(combo.id, {
      name: combo.name,
      strategy: "priority",
      steps: [{ modelIds: ["a"] }],
      config: { proxy_pool_id: 9 },
    });
    expect(comboProxyPoolId(updated!)).toBe(9);
    expect(updated!.config["other"]).toBe("keep");
    deleteCombo(combo.id);
  });
});

describe("extractUpstreamText", () => {
  test("openai chat: choices[0].message.content", () => {
    expect(
      extractUpstreamText({
        choices: [{ message: { role: "assistant", content: "hello" } }],
      }),
    ).toBe("hello");
  });
  test("openai responses: output[].content[].text", () => {
    expect(
      extractUpstreamText({
        output: [{ type: "message", content: [{ type: "output_text", text: "resp" }] }],
      }),
    ).toBe("resp");
  });
  test("anthropic: content[].text", () => {
    expect(extractUpstreamText({ content: [{ type: "text", text: "claude" }] })).toBe("claude");
  });
  test("gemini: candidates[0].content.parts[].text", () => {
    expect(
      extractUpstreamText({ candidates: [{ content: { parts: [{ text: "gem" }, { text: "ini" }] } }] }),
    ).toBe("gem\nini");
  });
  test("fallbacks & empty", () => {
    expect(extractUpstreamText({ choices: [{ text: "raw" }] })).toBe("raw");
    expect(extractUpstreamText({ content: "string-top" })).toBe("string-top");
    expect(extractUpstreamText(null)).toBe("");
    expect(extractUpstreamText({})).toBe("");
  });
});
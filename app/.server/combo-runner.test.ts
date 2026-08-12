import "./test-env";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";
import { query } from "./db";
import { createCombo } from "./combo";
import type { CanonicalRequest } from "./translate/canonical";
import type { runComboEngine as RunComboEngine } from "./combo-runner";

beforeAll(async () => {
  await resetTestDb();
  // Provider dummy dengan base_url tak terhubung → fetch gagal cepat,
  // sehingga kombo fallback/pipeline dapat diuji tanpa upstream asli.
  const p = query(
    `INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at)
     VALUES (?, ?, ?, 'none', 1, 1, 0, 0, 0)`,
  );
  p.run("dummy-a", "Dummy A", "http://127.0.0.1:1");
  p.run("dummy-b", "Dummy B", "http://127.0.0.1:1");
  query("INSERT INTO models (model_name, provider_id, is_active, is_primary) VALUES ('m-a', 'dummy-a', 1, 0)").run();
  query("INSERT INTO models (model_name, provider_id, is_active, is_primary) VALUES ('m-b', 'dummy-b', 1, 0)").run();
});
afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

const canonical = (): CanonicalRequest => ({
  model: "combo:test",
  messages: [{ role: "user", content: "halo dunia" }],
  stream: false,
  extra: {},
});

const request = (): Request =>
  new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "combo:test", messages: [{ role: "user", content: "halo" }] }),
    signal: AbortSignal.timeout(30_000),
  });

describe("runComboEngine (priority fallback chain)", () => {
  test("semua step gagal → 502 dan metric tercatat per step", async () => {
    const { runComboEngine } = (await import("./combo-runner")) as {
      runComboEngine: typeof RunComboEngine;
    };
    const combo = createCombo({
      name: "prio-fail",
      strategy: "priority",
      steps: [{ providerId: "dummy-a", modelIds: ["m-a"] }, { providerId: "dummy-b", modelIds: ["m-b"] }],
    });
    const res = await runComboEngine({
      combo,
      canonical: canonical(),
      rule: null,
      ruleApplied: null,
      request: request(),
      clientFormat: "openai-chat",
    });
    expect(res.status).toBe(502);
    const metrics = query(
      "SELECT step_index, model_id, success, error FROM combo_metrics WHERE combo_id = ? ORDER BY step_index",
    ).all(combo.id) as { step_index: number; model_id: string; success: number; error: string | null }[];
    // Priority: kedua step dicoba; keduanya gagal.
    expect(metrics).toHaveLength(2);
    expect(metrics.map((m) => m.step_index)).toEqual([0, 1]);
    expect(metrics.every((m) => m.success === 0)).toBe(true);
  });

  test("pipeline berhenti pada step pertama yang gagal", async () => {
    const { runComboEngine } = (await import("./combo-runner")) as {
      runComboEngine: typeof RunComboEngine;
    };
    const combo = createCombo({
      name: "pipe-fail",
      strategy: "pipeline",
      steps: [{ providerId: "dummy-a", modelIds: ["m-a"] }, { providerId: "dummy-b", modelIds: ["m-b"] }],
    });
    const res = await runComboEngine({
      combo,
      canonical: canonical(),
      rule: null,
      ruleApplied: null,
      request: request(),
      clientFormat: "openai-chat",
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("pipeline failed at step 1");
    const metrics = query(
      "SELECT COUNT(*) AS c FROM combo_metrics WHERE combo_id = ?",
    ).get(combo.id) as { c: number };
    // Pipeline: step 2 tidak pernah dieksekusi.
    expect(metrics.c).toBe(1);
  });
});
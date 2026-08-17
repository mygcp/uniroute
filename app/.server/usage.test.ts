import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-usage-test-${randomUUID()}.db`;

type UsageModule = typeof import("./usage");
type DbModule = typeof import("./db");

let usage: UsageModule;
let db: DbModule;

const DAY_MS = 86_400_000;

function insertLog(row: {
  model: string;
  provider_id: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  api_key_id?: number | null;
  created_at: number; // ms
}): void {
  db.query(
    `INSERT INTO request_logs (model, provider_id, prompt_tokens, completion_tokens, api_key_id, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, 'success')`,
  ).run(
    row.model,
    row.provider_id,
    row.prompt_tokens ?? null,
    row.completion_tokens ?? null,
    row.api_key_id ?? null,
    row.created_at,
  );
}

beforeAll(async () => {
  await resetTestDb();
  usage = await import("./usage");
  db = await import("./db");
  const now = Date.now();
  insertLog({ model: "gpt-4o", provider_id: "openai", prompt_tokens: 1000, completion_tokens: 500, created_at: now });
  insertLog({ model: "gpt-4o", provider_id: "openai", prompt_tokens: 2000, completion_tokens: 1000, created_at: now - DAY_MS });
  insertLog({ model: "claude-3-5-sonnet", provider_id: "anthropic", prompt_tokens: 500, completion_tokens: 200, created_at: now - 2 * DAY_MS });
  insertLog({ model: "claude-3-5-sonnet", provider_id: "anthropic", prompt_tokens: null, completion_tokens: null, created_at: now - 100 * DAY_MS });
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("getUsageData summary", () => {
  test("aggregates tokens and estimates cost for range=all", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.summary.inputTokens).toBe(3500); // 1000+2000+500
    expect(data.summary.outputTokens).toBe(1700); // 500+1000+200
    expect(data.summary.totalTokens).toBe(5200);
    expect(data.summary.cost).toBeCloseTo(
      (3000 * 2.5 + 1500 * 10 + 500 * 3 + 200 * 15) / 1_000_000,
      6,
    );
  });

  test("range=day only includes today's row", () => {
    const data = usage.getUsageData({ range: "day" });
    expect(data.summary.totalTokens).toBe(1500); // 1000+500
    expect(data.summary.inputTokens).toBe(1000);
    expect(data.summary.outputTokens).toBe(500);
  });
});

describe("time series", () => {
  test("range=week returns daily buckets ascending", () => {
    const data = usage.getUsageData({ range: "week", metric: "tokens" });
    const buckets = data.timeSeries;
    expect(buckets.length).toBeGreaterThan(0);
    expect(buckets[0].labelFull.localeCompare(buckets[buckets.length - 1].labelFull)).toBeLessThanOrEqual(0);
    for (const b of buckets) {
      expect(typeof b.value).toBe("number");
      expect(b.value).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("breakdown", () => {
  test("breakdown by provider aggregates correctly and sums pct to ~100", () => {
    const data = usage.getUsageData({ range: "all", metric: "tokens", dimension: "provider" });
    const byProvider = new Map(data.breakdown.map((b) => [b.name, b.value]));
    expect(byProvider.get("openai")).toBe(4500); // 1000+500 + 2000+1000
    expect(byProvider.get("anthropic")).toBe(700); // 500+200
    const pctSum = data.breakdown.reduce((s, b) => s + b.pct, 0);
    expect(pctSum).toBeLessThanOrEqual(100);
  });

  test("apikey dimension groups null keys as 'No API Key'", () => {
    const data = usage.getUsageData({ range: "all", dimension: "apikey" });
    const names = data.breakdown.map((b) => b.name);
    expect(names).toContain("No API Key");
  });
});

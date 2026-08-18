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

function insertErrorLog(model: string, providerId: string, errorMessage: string, created_at: number, status = "error"): void {
  db.query(
    `INSERT INTO request_logs (model, provider_id, prompt_tokens, completion_tokens, api_key_id, created_at, status, error_message)
     VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  ).run(model, providerId, created_at, status, errorMessage);
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
  insertErrorLog("gpt-4o", "openai", '{"error":{"message":"rate limit exceeded"}}', now - 2 * DAY_MS);
  insertErrorLog("gpt-4o", "openai", '{"error":{"message":"rate limit exceeded"}}', now - 3 * DAY_MS);
  insertErrorLog("gpt-4o", "openai", "model not found", now - 3 * DAY_MS);
  insertErrorLog("gpt-4o", "openai", "routing rule deny", now - 2 * DAY_MS, "denied");
  insertErrorLog("gpt-4o", "openai", "upstream timeout", now - 3 * DAY_MS, "timeout");
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

describe("getUsageData performance", () => {
  test("aggregates requests, success rate, latency, tokens/req, cost/req for range=all", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.performance.requests).toBe(9); // 4 success + 3 error + 1 denied + 1 timeout
    expect(data.performance.successRate).toBe(44); // round(4/9*100)
    expect(data.performance.avgLatencyMs).toBe(0);
    expect(data.performance.tokensPerReq).toBeCloseTo(577.778, 2); // 5200/9
    expect(data.performance.costPerReq).toBeCloseTo(0.003, 4); // 0.027/9
  });
});

describe("getUsageData trends", () => {
  test("range=all has no prior period (all null)", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.trends.totalTokens).toBeNull();
    expect(data.trends.requests).toBeNull();
    expect(data.trends.successRate).toBeNull();
  });

  test("range=day compares against yesterday", () => {
    const data = usage.getUsageData({ range: "day" });
    expect(data.summary.totalTokens).toBe(1500); // today: row at `now`
    expect(data.trends.totalTokens).toBe(-50); // (1500-3000)/3000
    expect(data.trends.inputTokens).toBe(-50);
    expect(data.trends.outputTokens).toBe(-50);
    expect(data.trends.cost).toBe(-50);
    expect(data.trends.requests).toBe(0);
    expect(data.trends.successRate).toBe(0); // absolute-point delta
    expect(data.trends.tokensPerReq).toBe(-50);
    expect(data.trends.avgLatencyMs).toBeNull();
  });
});

describe("getUsageData errors", () => {
  test("groups status counts and top error messages", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.errors.success).toBe(4);
    expect(data.errors.error).toBe(5); // 3 error + 1 denied + 1 timeout
    expect(data.errors.total).toBe(9);
    expect(data.errors.top).toHaveLength(4); // rate-limit(2), model not found, routing rule deny, upstream timeout
    expect(data.errors.top[0]).toEqual({ message: '{"error":{"message":"rate limit exceeded"}}', count: 2 });
    const messages = data.errors.top.map((e) => e.message);
    expect(messages).toContain("model not found");
    expect(messages).toContain("routing rule deny");
    expect(messages).toContain("upstream timeout");
  });

  test("status counts reconcile with performance.requests", () => {
    const data = usage.getUsageData({ range: "all" });
    expect(data.errors.success + data.errors.error).toBe(data.performance.requests);
  });

  test("range=day excludes previous days' errors", () => {
    const data = usage.getUsageData({ range: "day" });
    expect(data.errors.success).toBe(1);
    expect(data.errors.error).toBe(0);
    expect(data.errors.top).toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-pricing-test-${randomUUID()}.db`;

type PricingModule = typeof import("./pricing");
let pr: PricingModule;

beforeAll(async () => {
  await resetTestDb();
  pr = await import("./pricing");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("pricing", () => {
  test("getPrice returns static price for known model", () => {
    expect(pr.getPrice("gpt-4o")).toEqual({ input: 2.5, output: 10 });
    const price = pr.getPrice("gpt-4o", "openai");
    expect(price.input).toBeGreaterThan(0);
  });

  test("getPrice returns zero for unknown model", () => {
    expect(pr.getPrice("totally-unknown-model")).toEqual({ input: 0, output: 0 });
  });

  test("override wins over static price", () => {
    pr.setPrice("gpt-4o", "openai", 5, 20);
    expect(pr.getPrice("gpt-4o", "openai")).toEqual({ input: 5, output: 20 });
    pr.deleteOverride("gpt-4o", "openai");
    expect(pr.getPrice("gpt-4o", "openai")).toEqual({ input: 2.5, output: 10 });
  });

  test("model-only override applies regardless of provider", () => {
    pr.setPrice("gpt-4o", "", 3.5, 12);
    expect(pr.getPrice("gpt-4o", "openai")).toEqual({ input: 3.5, output: 12 });
    pr.deleteOverride("gpt-4o", "");
  });

  test("estimateCost computes USD from tokens", () => {
    const cost = pr.estimateCost("gpt-4o", "openai", 1000, 500);
    // (1000*2.5 + 500*10)/1M = (2500+5000)/1M = 0.0075
    expect(cost).toBeCloseTo(0.0075, 6);
  });

  test("listOverrides returns saved overrides", () => {
    pr.setPrice("gpt-4o-mini", "openai", 0.2, 0.8);
    const overrides = pr.listOverrides();
    expect(overrides.some((o) => o.model === "gpt-4o-mini" && o.input_per_mtok === 0.2)).toBe(true);
    pr.deleteOverride("gpt-4o-mini", "openai");
  });
});
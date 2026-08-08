import { describe, expect, test } from "bun:test";
import {
  beginConnection,
  endConnection,
  selectProvider,
  setHealth,
} from "./balancer";
import { query } from "./db";
import type { Provider } from "./registry";

const MODEL = "balancer-test-model";

function providers(): Provider[] {
  const base = (
    id: string,
    weight: number,
    priority: number,
    conns: number,
    used: number,
  ): Provider => ({
    id,
    name: id,
    base_url: "http://mock.example.com",
    auth_type: "bearer",
    is_active: true,
    weight,
    priority,
    current_connections: conns,
    last_used_at: used,
  });
  return [
    base("A", 3, 2, 5, 0),
    base("B", 1, 1, 1, 1),
    base("C", 2, 0, 3, 2),
  ];
}

function setStrategy(strategy: string, healthEnabled = 0) {
  query(
    `INSERT INTO load_balancing (model_name, strategy, fallback_enabled, health_check_enabled)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(model_name) DO UPDATE SET
       strategy = ?, health_check_enabled = ?`,
  ).run(MODEL, strategy, healthEnabled, strategy, healthEnabled);
}

function clearStrategy() {
  query("DELETE FROM load_balancing WHERE model_name = ?").run(MODEL);
}

describe("round_robin", () => {
  test("picks least recently used", () => {
    expect(selectProvider(providers(), MODEL)?.id).toBe("A");
  });

  test("rotates after older providers are used", () => {
    const pool = providers();
    pool[0].last_used_at = 100; // A already used
    expect(selectProvider(pool, MODEL)?.id).toBe("B");
  });

  test("undefined on empty pool", () => {
    expect(selectProvider([], MODEL)).toBeUndefined();
  });
});

describe("random", () => {
  test("covers all providers over 500 iterations", () => {
    setStrategy("random");
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(selectProvider(providers(), MODEL)!.id);
    }
    expect(seen).toEqual(new Set(["A", "B", "C"]));
    clearStrategy();
  });
});

describe("priority", () => {
  test("always picks highest priority (A)", () => {
    setStrategy("priority");
    for (let i = 0; i < 20; i++) {
      expect(selectProvider(providers(), MODEL)?.id).toBe("A");
    }
    clearStrategy();
  });
});

describe("weighted", () => {
  test("distribution approximates weights", () => {
    setStrategy("weighted");
    const counts: Record<string, number> = { A: 0, B: 0, C: 0 };
    const iterations = 2000;
    for (let i = 0; i < iterations; i++) {
      counts[selectProvider(providers(), MODEL)!.id] += 1;
    }
    const ratio = (id: string) => counts[id] / iterations;
    expect(Math.abs(ratio("A") - 0.5)).toBeLessThan(0.05);
    expect(Math.abs(ratio("B") - 1 / 6)).toBeLessThan(0.06);
    expect(Math.abs(ratio("C") - 1 / 3)).toBeLessThan(0.05);
    clearStrategy();
  });
});

describe("least_conn", () => {
  test("always picks least connected (B)", () => {
    setStrategy("least_conn");
    expect(selectProvider(providers(), MODEL)?.id).toBe("B");
    clearStrategy();
  });

  test("begin/endConnection adjust the provider counter", () => {
    const get = () =>
      (query("SELECT current_connections AS c FROM providers WHERE id = 'openai'").get() as { c: number }).c;
    const before = get();
    beginConnection("openai");
    const mid = get();
    endConnection("openai");
    const after = get();
    expect(before).toBeGreaterThanOrEqual(0);
    expect(mid).toBe(before + 1);
    expect(after).toBe(before);
  });
});

describe("first_available", () => {
  test("returns undefined when all providers unhealthy", () => {
    setStrategy("first_available", 1);
    setHealth("A", false);
    setHealth("B", false);
    setHealth("C", false);
    expect(selectProvider(providers(), MODEL)).toBeUndefined();
    clearStrategy();
  });

  test("returns the first healthy provider", () => {
    setStrategy("first_available", 1);
    setHealth("A", true);
    setHealth("B", false);
    expect(selectProvider(providers(), MODEL)?.id).toBe("A");
    clearStrategy();
  });
});
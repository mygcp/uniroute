import { describe, expect, test } from "bun:test";
import { createLimiter, runEphemeralJob, singleflight, TtlCache } from "./async-utils";

describe("async-utils", () => {
  test("createLimiter caps concurrent executions and preserves result mapping", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        limit(async () => {
          active += 1;
          if (active > peak) peak = active;
          await new Promise((r) => setTimeout(r, 10));
          active -= 1;
          return n * 10;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  test("singleflight coalesces overlapping calls and releases key on error", async () => {
    let runs = 0;
    const [a, b, c] = await Promise.all([
      singleflight("sf-ok", async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, 10));
        return 42;
      }),
      singleflight("sf-ok", async () => {
        runs += 1;
        return 99;
      }),
      singleflight("sf-ok", async () => {
        runs += 1;
        return 100;
      }),
    ]);

    expect(runs).toBe(1);
    expect([a, b, c]).toEqual([42, 42, 42]);

    await expect(
      singleflight("sf-err", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    const retry = await singleflight("sf-err", async () => "recovered");
    expect(retry).toBe("recovered");
  });

  test("TtlCache evicts oldest entry and expires items after TTL", async () => {
    const cache = new TtlCache<string, number>(2, 40);
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);

    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
  });

  test("runEphemeralJob executes subprocess and invokes fallback on failure", async () => {
    const script = `
      let s = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (d) => s += d);
      process.stdin.on("end", () => {
        const v = JSON.parse(s);
        process.stdout.write(JSON.stringify({ sum: v.a + v.b }));
      });
    `;
    const out = await runEphemeralJob<{ a: number; b: number }, { sum: number }>(
      script,
      { a: 3, b: 4 },
      { timeoutMs: 10_000 },
    );
    expect(out).toEqual({ sum: 7 });

    const fb = await runEphemeralJob<{ a: number }, { ok: boolean }>(
      `process.exit(1);`,
      { a: 1 },
      {
        timeoutMs: 5_000,
        fallback: async () => ({ ok: true }),
      },
    );
    expect(fb).toEqual({ ok: true });
  });
});

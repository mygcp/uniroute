import "./test-env";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-proxy-resolver-test-${randomUUID()}.db`;

beforeAll(async () => {
  await resetTestDb();
  const db = await import("./db");
  db.seed();
});

import {
  assignProxies,
  deleteProxy,
  fetchUpstream,
  formatProxy,
  getActivePool,
  getProxy,
  listAssignments,
  listProxies,
  parseBulkProxies,
  removeProxyAssignment,
  resolveProxy,
  resolveProxyCandidates,
  resolveProxyForKey,
  roundRobinPick,
  setProxyActive,
  touchProxy,
  updateProxy,
  upsertProxy,
} from "./proxy-resolver";
import { getRoutingCredential } from "./credential";
import { query } from "./db";

describe("proxy CRUD", () => {
  test("tables & proxy_id column exist", () => {
    const tables = (query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toContain("proxies");
    expect(tables).toContain("provider_proxies");
    const cols = (query("PRAGMA table_info(provider_credentials)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("proxy_id");
  });

  test("upsertProxy inserts and returns id", () => {
    const { id, inserted } = upsertProxy({ protocol: "http", host: "1.2.3.4", port: 8080, username: null, password: null });
    expect(inserted).toBe(true);
    expect(getProxy(id)?.host).toBe("1.2.3.4");
  });

  test("upsertProxy is idempotent on duplicate (host/port/protocol)", () => {
    const first = upsertProxy({ protocol: "socks5", host: "proxy.local", port: 1080, username: "u", password: "p" });
    const second = upsertProxy({ protocol: "socks5", host: "proxy.local", port: 1080, username: "u", password: "p" });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.id).toBe(first.id);
  });

  test("updateProxy and setProxyActive mutate row", () => {
    const { id } = upsertProxy({ protocol: "http", host: "a.example", port: 80, username: null, password: null });
    updateProxy(id, { protocol: "http", host: "b.example", port: 81, username: "x", password: "y" });
    const row = getProxy(id)!;
    expect(row.host).toBe("b.example");
    expect(row.port).toBe(81);
    setProxyActive(id, false);
    expect(getProxy(id)!.is_active).toBe(0);
  });

  test("deleteProxy removes row and clears credentials + assignments", () => {
    const { id } = upsertProxy({ protocol: "http", host: "c.example", port: 82, username: null, password: null });
    assignProxies("openai", [id]);
    query("INSERT INTO provider_credentials (provider_id, label, api_key, is_active, is_routing, proxy_id, updated_at) VALUES ('openai', 't', 'k', 1, 1, ?, unixepoch())").run(id);
    deleteProxy(id);
    expect(getProxy(id)).toBeUndefined();
    const cred = query("SELECT proxy_id FROM provider_credentials WHERE api_key = 'k'").get() as { proxy_id: number | null };
    expect(cred.proxy_id).toBeNull();
    const assignments = query("SELECT COUNT(*) AS c FROM provider_proxies WHERE proxy_id = ?").get(id) as { c: number };
    expect(assignments.c).toBe(0);
  });
});

describe("provider_proxies assignments", () => {
  test("assign & remove proxy from provider", () => {
    const { id: p1 } = upsertProxy({ protocol: "http", host: "d.example", port: 83, username: null, password: null });
    const { id: p2 } = upsertProxy({ protocol: "http", host: "e.example", port: 84, username: null, password: null });
    assignProxies("deepseek", [p1, p2]);
    assignProxies("deepseek", [p1]); // idempotent
    expect(listAssignments().filter((a) => a.provider_id === "deepseek").length).toBe(2);
    removeProxyAssignment("deepseek", p1);
    const remaining = listAssignments().filter((a) => a.provider_id === "deepseek").map((a) => a.proxy_id);
    expect(remaining).toEqual([p2]);
  });
});

describe("parseBulkProxies", () => {
  test("plain lines: host:port and host:port:user:pass", () => {
    const { imported, skipped } = parseBulkProxies(
      "1.2.3.4:8080\n5.6.7.8:3128:user:pass\n",
    );
    expect(skipped).toEqual([]);
    expect(imported).toEqual([
      { protocol: "http", host: "1.2.3.4", port: 8080, username: null, password: null },
      { protocol: "http", host: "5.6.7.8", port: 3128, username: "user", password: "pass" },
    ]);
  });

  test("url lines with protocol and credentials", () => {
    const { imported, skipped } = parseBulkProxies(
      "socks5://user:pass@10.0.0.1:1080\nhttp://10.0.0.2:8080\nhttp://u%40x:p%3Ay@10.0.0.3:8080",
    );
    expect(skipped).toEqual([]);
    expect(imported).toEqual([
      { protocol: "socks5", host: "10.0.0.1", port: 1080, username: "user", password: "pass" },
      { protocol: "http", host: "10.0.0.2", port: 8080, username: null, password: null },
      { protocol: "http", host: "10.0.0.3", port: 8080, username: "u@x", password: "p:y" },
    ]);
  });

  test("ipv6 bracketed", () => {
    const { imported, skipped } = parseBulkProxies("[::1]:1080\nhttp://u:p@[::1]:3128");
    expect(skipped).toEqual([]);
    expect(imported).toEqual([
      { protocol: "http", host: "::1", port: 1080, username: null, password: null },
      { protocol: "http", host: "::1", port: 3128, username: "u", password: "p" },
    ]);
  });

  test("json array", () => {
    const text = JSON.stringify([
      { protocol: "socks5", host: "pi.example", port: 1080 },
      { protocol: "http", host: "www.example", port: 80, username: "a", password: "b" },
    ]);
    const { imported, skipped } = parseBulkProxies(text);
    expect(skipped).toEqual([]);
    expect(imported).toEqual([
      { protocol: "socks5", host: "pi.example", port: 1080, username: null, password: null },
      { protocol: "http", host: "www.example", port: 80, username: "a", password: "b" },
    ]);
  });

  test("invalid entries skipped with reasons", () => {
    const { imported, skipped } = parseBulkProxies("not-a-proxy\n1.2.3.4:999999\n");
    expect(imported).toEqual([]);
    expect(skipped.length).toBe(2);
  });

  test("duplicates within input and vs existing are skipped", () => {
    const { imported, skipped } = parseBulkProxies(
      "1.2.3.4:8080\n1.2.3.4:8080\n2.3.4.5:8080",
      [{ id: 9, protocol: "http", host: "2.3.4.5", port: 8080, username: null, password: null }],
    );
    expect(imported).toEqual([
      { protocol: "http", host: "1.2.3.4", port: 8080, username: null, password: null },
    ]);
    expect(skipped).toContain("duplicate: http://1.2.3.4:8080");
    expect(skipped.some((s) => s.includes("2.3.4.5"))).toBe(true);
  });

  test("empty input returns nothing", () => {
    expect(parseBulkProxies("  \n")).toEqual({ imported: [], skipped: [] });
  });
});

describe("getActivePool & roundRobinPick", () => {
  test("returns only active proxies, most-recently-used last", () => {
    const a = upsertProxy({ protocol: "http", host: "p1.example", port: 1080, username: null, password: null });
    const b = upsertProxy({ protocol: "http", host: "p2.example", port: 1081, username: null, password: null });
    const d = upsertProxy({ protocol: "http", host: "dead.example", port: 1082, username: null, password: null });
    setProxyActive(d.id, false);
    assignProxies("openai", [a.id, b.id, d.id]);
    touchProxy(a.id);
    const pool = getActivePool("openai");
    expect(pool.map((p) => p.host)).toEqual(["p2.example", "p1.example"]);
  });

  test("roundRobinPick rotates through pool", () => {
    const a = upsertProxy({ protocol: "http", host: "r1.example", port: 1080, username: null, password: null });
    const b = upsertProxy({ protocol: "http", host: "r2.example", port: 1081, username: null, password: null });
    assignProxies("anthropic", [a.id, b.id]);
    const first = roundRobinPick(getActivePool("anthropic"));
    expect(first?.host).toBe("r1.example");
    const second = roundRobinPick(getActivePool("anthropic"));
    expect(second?.host).toBe("r2.example");
    expect(roundRobinPick([])).toBeUndefined();
  });
});

describe("resolveProxy hierarchy", () => {
  test("touches last_used_at via pick", () => {
    const a = upsertProxy({ protocol: "http", host: "t1.example", port: 1080, username: null, password: null });
    const before = getProxy(a.id)!.last_used_at;
    touchProxy(a.id);
    expect(getProxy(a.id)!.last_used_at).toBeGreaterThanOrEqual(before);
  });
});

describe("resolveProxy candidates", () => {
  test("key proxy wins over pool", () => {
    const key = upsertProxy({ protocol: "http", host: "key.example", port: 1080, username: null, password: null });
    const pool = upsertProxy({ protocol: "http", host: "pool.example", port: 1081, username: null, password: null });
    assignProxies("groq", [pool.id]);
    query(
      "INSERT INTO provider_credentials (provider_id, label, api_key, is_active, is_routing, proxy_id, updated_at) VALUES ('groq', 't', 'k', 1, 1, ?, unixepoch())",
    ).run(key.id);
    expect(resolveProxy("groq")?.host).toBe("key.example");
    expect(resolveProxyCandidates("groq").map((p) => p.host)).toEqual(["key.example"]);
  });

  test("pool only when no key proxy", () => {
    const a = upsertProxy({ protocol: "http", host: "c1.example", port: 1080, username: null, password: null });
    assignProxies("google", [a.id]);
    const hosts = resolveProxyCandidates("google").map((p) => p.host);
    expect(hosts).toContain("c1.example");
  });

  test("null when no proxy configured", () => {
    expect(resolveProxy("mistral")).toBeNull();
    expect(resolveProxyCandidates("mistral")).toEqual([]);
  });
});

describe("credential proxy helpers", () => {
  test("getRoutingCredential returns proxy_id of routing key", () => {
    const key = upsertProxy({ protocol: "http", host: "cred.example", port: 1080, username: null, password: null });
    query(
      "INSERT INTO provider_credentials (provider_id, label, api_key, is_active, is_routing, proxy_id, updated_at) VALUES ('openrouter', 't', 'k', 1, 1, ?, unixepoch())",
    ).run(key.id);
    expect(getRoutingCredential("openrouter")?.proxy_id).toBe(key.id);
  });
});

describe("formatProxy", () => {
  test("http and socks5 output", () => {
    expect(formatProxy({ id: 1, protocol: "http", host: "h", port: 80, username: "u", password: "p" })).toEqual({ proxy: "http://u:p@h:80" });
    expect(formatProxy({ id: 2, protocol: "socks5", host: "h", port: 1080, username: null, password: null })).toEqual({ socks: "socks5://h:1080" });
  });
});

describe("fetchUpstream", () => {
  test("injects proxy/socks option and passes through without proxy", async () => {
    let captured: { url: string; init: unknown } | null = null;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init: unknown) => {
      captured = { url: String(url), init };
      return new Response("ok");
    }) as unknown as typeof fetch;
    try {
      await fetchUpstream("http://up.example/v1", { method: "POST" }, { id: 1, protocol: "http", host: "px", port: 8080, username: "u", password: "p" });
      expect(captured!.init).toMatchObject({ proxy: "http://u:p@px:8080" });
      await fetchUpstream("http://up.example/v1", { method: "POST" }, null);
      expect((captured!.init as Record<string, unknown>).proxy).toBeUndefined();
      expect((captured!.init as Record<string, unknown>).method).toBe("POST");
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("resolveProxyForKey", () => {
  test("uses key proxy when active", () => {
    const key = upsertProxy({ protocol: "http", host: "kf.example", port: 1080, username: null, password: null });
    expect(resolveProxyForKey("cohere", key.id)?.host).toBe("kf.example");
  });

  test("falls back to pool when key not found", () => {
    const p = upsertProxy({ protocol: "socks5", host: "fp.example", port: 1080, username: null, password: null });
    assignProxies("opencode", [p.id]);
    expect(resolveProxyForKey("opencode", 99999)?.host).toBe("fp.example");
  });

  test("null keys return null", () => {
    expect(resolveProxyForKey("mistral", null)).toBeNull();
  });
});
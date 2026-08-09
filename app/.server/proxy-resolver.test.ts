import "./test-env";
import { describe, expect, test } from "bun:test";
import {
  assignProxies,
  deleteProxy,
  getProxy,
  listAssignments,
  listProxies,
  removeProxyAssignment,
  setProxyActive,
  updateProxy,
  upsertProxy,
} from "./proxy-resolver";
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
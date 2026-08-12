import "./test-env";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { resetTestDb } from "./test-db";

process.env.DATABASE_URL = `/tmp/uniroute-outbound-proxy-test-${randomUUID()}.db`;

beforeAll(async () => {
  await resetTestDb();
  const db = await import("./db");
  db.seed();
});

import {
  assignPool,
  bulkImportProxies,
  createPool,
  createProxy,
  deletePool,
  deleteProxy,
  getPool,
  getPoolForApiKey,
  getPoolForProvider,
  getProxy,
  listAssignments,
  listPools,
  listProxies,
  unassignPool,
  updatePool,
  updateProxy,
} from "./outbound-proxy";

describe("outbound-proxy CRUD", () => {
  test("create/list/get proxy", () => {
    const p = createProxy({
      name: "us-east",
      type: "http-connect",
      host: "proxy.example.com",
      port: 8080,
      username: "user1",
      password: "pw1",
    });
    expect(p.id).toBeGreaterThan(0);
    expect(p.password).toBe("pw1");
    expect(listProxies().some((x) => x.id === p.id)).toBe(true);
    const fetched = getProxy(p.id);
    expect(fetched?.host).toBe("proxy.example.com");
    expect(fetched?.is_active).toBe(true);
  });

  test("update proxy fields + deactivate", () => {
    const p = createProxy({ name: "old", type: "http-connect", host: "a", port: 1 });
    const updated = updateProxy(p.id, { name: "new", port: 3128, is_active: false });
    expect(updated?.name).toBe("new");
    expect(updated?.port).toBe(3128);
    expect(updated?.is_active).toBe(false);
    expect(getProxy(p.id)?.is_active).toBe(false);
  });

  test("delete proxy removes it from pools", () => {
    const p = createProxy({ name: "gone", type: "socks5", host: "b", port: 1080 });
    const pool = createPool({ name: "pool", proxy_ids: [p.id] });
    deleteProxy(p.id);
    expect(getProxy(p.id)).toBeNull();
    expect(getPool(pool.id)?.proxy_ids).toEqual([]);
  });

  test("socks5 type persisted", () => {
    const p = createProxy({ name: "socks", type: "socks5", host: "c", port: 1080 });
    expect(getProxy(p.id)?.type).toBe("socks5");
  });
});

describe("proxy pools", () => {
  test("create/update/list/get pool with JSON proxy_ids", () => {
    const p1 = createProxy({ name: "p1", type: "http-connect", host: "h1", port: 80 });
    const p2 = createProxy({ name: "p2", type: "http-connect", host: "h2", port: 80 });
    const pool = createPool({ name: "team", proxy_ids: [p1.id, p2.id] });
    expect(pool.proxy_ids).toEqual([p1.id, p2.id]);
    expect(listPools().some((x) => x.id === pool.id)).toBe(true);

    const updated = updatePool(pool.id, { proxy_ids: [p2.id], is_active: false });
    expect(updated?.proxy_ids).toEqual([p2.id]);
    expect(updated?.is_active).toBe(false);
  });

  test("delete pool removes assignments", () => {
    const pool = createPool({ name: "tmp" });
    assignPool({ proxyPoolId: pool.id, targetType: "provider", targetId: "prov-x" });
    expect(listAssignments().length).toBeGreaterThan(0);
    deletePool(pool.id);
    expect(getPool(pool.id)).toBeNull();
    expect(listAssignments().some((a) => a.proxy_pool_id === pool.id)).toBe(false);
  });
});

describe("assignments & resolution helpers", () => {
  test("assign/unassign provider + api key", () => {
    const pool = createPool({ name: "assigned" });
    assignPool({ proxyPoolId: pool.id, targetType: "provider", targetId: "prov-a" });
    assignPool({ proxyPoolId: pool.id, targetType: "client_key", targetId: "7" });

    expect(getPoolForProvider("prov-a")?.id).toBe(pool.id);
    expect(getPoolForApiKey(7)?.id).toBe(pool.id);
    expect(getPoolForProvider("prov-b")).toBeNull();

    unassignPool("provider", "prov-a");
    expect(getPoolForProvider("prov-a")).toBeNull();
    expect(getPoolForApiKey(7)?.id).toBe(pool.id);
  });

  test("inactive pool is not resolved", () => {
    const pool = createPool({ name: "sleeping", is_active: false });
    assignPool({ proxyPoolId: pool.id, targetType: "provider", targetId: "prov-z" });
    expect(getPoolForProvider("prov-z")).toBeNull();
  });
});

describe("bulk import", () => {
  test("imports lines with pool grouping and reports errors", () => {
    const res = bulkImportProxies([
      { host: "1.1.1.1", port: 8080, poolName: "grp" },
      { host: "2.2.2.2", port: 1080, type: "socks5", username: "u", password: "p" },
      { host: "", port: 0 },
    ]);
    expect(res.imported).toBe(2);
    expect(res.errors.length).toBe(1);
    const pool = listPools().find((p) => p.name === "grp");
    expect(pool?.proxy_ids.length).toBe(1);
    const socks = listProxies().find((p) => p.host === "2.2.2.2");
    expect(socks?.type).toBe("socks5");
  });
});

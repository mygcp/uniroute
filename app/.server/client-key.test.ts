import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetTestDb } from "./test-db";
import { query } from "./db";

process.env.DATABASE_URL = `/tmp/uniroute-client-key-test-${randomUUID()}.db`;

type ClientKeyModule = typeof import("./client-key");
let ck: ClientKeyModule;

beforeAll(async () => {
  await resetTestDb();
  ck = await import("./client-key");
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("client key generation & hashing", () => {
  test("generateKey returns sk- prefixed random key", () => {
    const a = ck.generateKey();
    const b = ck.generateKey();
    expect(a.startsWith("sk-")).toBe(true);
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(10);
  });

  test("generateKey honors a custom prefix", () => {
    const k = ck.generateKey("ur-");
    expect(k.startsWith("ur-")).toBe(true);
    expect(k).not.toContain("sk-");
  });

  test("generateKey falls back to sk- for invalid prefixes", () => {
    expect(ck.generateKey("").startsWith("sk-")).toBe(true);
    expect(ck.generateKey("  ").startsWith("sk-")).toBe(true);
    expect(ck.generateKey("has space").startsWith("sk-")).toBe(true);
    expect(ck.generateKey("bad.prefix!").startsWith("sk-")).toBe(true);
  });

  test("hashKey produces 64-char hex and differs per input", () => {
    const h = ck.hashKey("secret-1");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toBe(ck.hashKey("secret-2"));
  });
});

describe("create & resolve client key", () => {
  test("createClientKey persists hash, not the raw key", () => {
    const { key, id } = ck.createClientKey({ name: "Frontend" });
    expect(key.startsWith("sk-")).toBe(true);

    const stored = ck.getClientKeyById(id);
    expect(stored).toBeDefined();
    expect(stored!.key_hash).toBe(ck.hashKey(key));
    expect(stored!.key_hash).not.toContain(key);
    expect(stored!.key_prefix).toBe("sk-");
  });

  test("createClientKey persists a custom prefix", () => {
    const { key, id } = ck.createClientKey({ name: "Frontend", prefix: "ur-" });
    expect(key.startsWith("ur-")).toBe(true);
    const stored = ck.getClientKeyById(id);
    expect(stored?.key_prefix).toBe("ur-");
    ck.deleteClientKey(id);
  });

  test("resolveClientKey returns the key row for a valid token", () => {
    const { key, id } = ck.createClientKey({ name: "Bot X" });
    const resolved = ck.resolveClientKey(key);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.key.id).toBe(id);
      expect(resolved.key.name).toBe("Bot X");
    }
  });

  test("resolveClientKey rejects unknown token", () => {
    const resolved = ck.resolveClientKey("sk-does-not-exist");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.status).toBe(401);
    }
  });

  test("resolveClientKey rejects null token", () => {
    expect(ck.resolveClientKey(null).ok).toBe(false);
  });

  test("resolveClientKey rejects inactive key", () => {
    const { key, id } = ck.createClientKey({ name: "off" });
    ck.setClientKeyActive(id, false);
    const resolved = ck.resolveClientKey(key);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.status).toBe(401);
  });
});

describe("per-key rules", () => {
  test("modelAllowed allows matching prefix", () => {
    const { key, id } = ck.createClientKey({
      name: "gpt-only",
      allowedModels: ["gpt-", "o3-"],
    });
    const resolved = ck.resolveClientKey(key)!;
    if (resolved.ok) {
      expect(ck.modelAllowed(resolved.key, "gpt-4o")).toBe(true);
      expect(ck.modelAllowed(resolved.key, "o3-mini")).toBe(true);
      expect(ck.modelAllowed(resolved.key, "claude-3")).toBe(false);
    }
    ck.deleteClientKey(id);
  });

  test("modelAllowed allows everything when allowedModels empty", () => {
    const { key, id } = ck.createClientKey({ name: "open" });
    const resolved = ck.resolveClientKey(key)!;
    if (resolved.ok) {
      expect(ck.modelAllowed(resolved.key, "anything-xyz")).toBe(true);
    }
    ck.deleteClientKey(id);
  });

  test("model override and pinned provider are persisted", () => {
    const { id } = ck.createClientKey({
      name: "test",
      modelOverride: "gpt-4o-mini",
      pinnedProviderId: "local",
    });
    const stored = ck.getClientKeyById(id);
    expect(stored?.model_override).toBe("gpt-4o-mini");
    expect(stored?.pinned_provider_id).toBe("local");
  });

  test("updateClientKeyRules updates rules", () => {
    const { id } = ck.createClientKey({ name: "edit-me" });
    ck.updateClientKeyRules(id, {
      name: "renamed",
      allowedModels: ["gpt-", "claude-"],
      modelOverride: "claude-sonnet-4",
      pinnedProviderId: "anthropic",
    });
    const stored = ck.getClientKeyById(id);
    expect(stored?.name).toBe("renamed");
    expect(stored?.allowed_models).toEqual(["gpt-", "claude-"]);
    expect(stored?.model_override).toBe("claude-sonnet-4");
    expect(stored?.pinned_provider_id).toBe("anthropic");
  });

  test("updateClientKeyRules clears optional rules with empty input", () => {
    const { id } = ck.createClientKey({
      name: "reset",
      modelOverride: "gpt-4o-mini",
      pinnedProviderId: "local",
    });
    ck.updateClientKeyRules(id, {});
    const stored = ck.getClientKeyById(id);
    expect(stored?.allowed_models).toBeNull();
    expect(stored?.model_override).toBeNull();
    expect(stored?.pinned_provider_id).toBeNull();
  });
});

describe("api manager fields", () => {
  test("createClientKey persists description, budget, quota, ip lists, expiry", () => {
    const { id } = ck.createClientKey({
      name: "rich",
      description: "tier-2 client",
      blockedModels: ["gpt-4o-mini"],
      allowedProviders: ["openai", "anthropic"],
      blockedProviders: ["deepseek"],
      budget: { monthly: 100, daily: 5, per_request: 0.01 },
      quota: { tokens_per_month: 1_000_000, requests_per_day: 1000, concurrent_requests: 5 },
      alertThreshold: 0.8,
      autoBlock: true,
      ipWhitelist: ["192.168.1.0/24"],
      ipBlacklist: ["203.0.113.1"],
      strictIp: true,
      accessHours: { enabled: true, timezone: "Asia/Jakarta", allowed_days: ["monday"] },
      expiresAt: 1798758000,
      webhookUrl: "https://x.example/hook",
      scopes: ["manage"],
    });
    const stored = ck.getClientKeyById(id);
    expect(stored?.description).toBe("tier-2 client");
    expect(stored?.blocked_models).toEqual(["gpt-4o-mini"]);
    expect(stored?.allowed_providers).toEqual(["openai", "anthropic"]);
    expect(stored?.blocked_providers).toEqual(["deepseek"]);
    expect(stored?.budget).toEqual({ monthly: 100, daily: 5, per_request: 0.01 });
    expect(stored?.quota).toEqual({
      tokens_per_month: 1_000_000,
      requests_per_day: 1000,
      concurrent_requests: 5,
    });
    expect(stored?.alert_threshold).toBe(0.8);
    expect(stored?.auto_block).toBe(1);
    expect(stored?.ip_whitelist).toEqual(["192.168.1.0/24"]);
    expect(stored?.ip_blacklist).toEqual(["203.0.113.1"]);
    expect(stored?.strict_ip).toBe(1);
    expect(stored?.access_hours?.timezone).toBe("Asia/Jakarta");
    expect(stored?.expires_at).toBe(1798758000);
    expect(stored?.webhook_url).toBe("https://x.example/hook");
    expect(stored?.scopes).toEqual(["manage"]);
    ck.deleteClientKey(id);
  });

  test("updateClientKey partial update preserves other fields", () => {
    const { id } = ck.createClientKey({
      name: "keep",
      budget: { monthly: 50 },
      blockedModels: ["llama-3-8b"],
    });
    ck.updateClientKey(id, { name: "kept" });
    const stored = ck.getClientKeyById(id);
    expect(stored?.name).toBe("kept");
    expect(stored?.budget).toEqual({ monthly: 50 });
    expect(stored?.blocked_models).toEqual(["llama-3-8b"]);
    ck.deleteClientKey(id);
  });

  test("resolveClientKey rejects key with blocked_at", () => {
    const { key, id } = ck.createClientKey({ name: "suspended" });
    ck.setClientKeyBlocked(id, 1234);
    const resolved = ck.resolveClientKey(key);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.status).toBe(401);
  });

  test("resolveClientKey accepts previous_key_hash during grace, flags usedPrevious", () => {
    const { key, id } = ck.createClientKey({ name: "rotated" });
    const oldHash = ck.hashKey(key);
    const newKey = "sk-rotated-new-value-12345";
    ck.updateClientKey(id, {});
    query(
      `UPDATE client_api_keys SET key_hash = ?, previous_key_hash = ?, previous_expires_at = ? WHERE id = ?`,
    ).run(ck.hashKey(newKey), oldHash, Math.floor(Date.now() / 1000) + 3600, id);

    const oldResolved = ck.resolveClientKey(key);
    expect(oldResolved.ok).toBe(true);
    if (oldResolved.ok) expect(oldResolved.usedPrevious).toBe(true);
    const newResolved = ck.resolveClientKey(newKey);
    expect(newResolved.ok).toBe(true);
    if (newResolved.ok) expect(newResolved.usedPrevious).toBe(false);
    ck.deleteClientKey(id);
  });

  test("resolveClientKey rejects previous key after grace expires", () => {
    const { key, id } = ck.createClientKey({ name: "expired-grace" });
    const oldHash = ck.hashKey(key);
    query(
      `UPDATE client_api_keys SET key_hash = ?, previous_key_hash = ?, previous_expires_at = ? WHERE id = ?`,
    ).run(ck.hashKey("sk-new"), oldHash, Math.floor(Date.now() / 1000) - 1, id);
    const resolved = ck.resolveClientKey(key);
    expect(resolved.ok).toBe(false);
    ck.deleteClientKey(id);
  });

  test("modelBlocked, providerAllowed, providerBlocked helpers", () => {
    const { key, id } = ck.createClientKey({
      name: "blockers",
      blockedModels: ["llama-"],
      allowedProviders: ["openai"],
      blockedProviders: ["*"],
    });
    const resolved = ck.resolveClientKey(key);
    if (resolved.ok) {
      expect(ck.modelBlocked(resolved.key, "llama-3-8b")).toBe(true);
      expect(ck.modelBlocked(resolved.key, "gpt-4o")).toBe(false);
      expect(ck.providerAllowed(resolved.key, "openai")).toBe(true);
      expect(ck.providerAllowed(resolved.key, "anthropic")).toBe(false);
      expect(ck.providerBlocked(resolved.key, "anthropic")).toBe(true);
    }
    ck.deleteClientKey(id);
  });
});

describe("master switch (require_api_key)", () => {
  test("defaults to off", () => {
    expect(ck.isRequireApiKey()).toBe(false);
  });

  test("setRequireApiKey toggles", () => {
    ck.setRequireApiKey(true);
    expect(ck.isRequireApiKey()).toBe(true);
    ck.setRequireApiKey(false);
    expect(ck.isRequireApiKey()).toBe(false);
  });
});

describe("client key listing & lifecycle", () => {
  test("listClientKeys returns created keys", () => {
    const before = ck.listClientKeys().length;
    ck.createClientKey({ name: "Tmp" });
    expect(ck.listClientKeys().length).toBe(before + 1);
  });

  test("deleteClientKey removes the row", () => {
    const { id } = ck.createClientKey({ name: "tmp-delete" });
    expect(ck.getClientKeyById(id)).toBeDefined();
    ck.deleteClientKey(id);
    expect(ck.getClientKeyById(id)).toBeUndefined();
  });
});

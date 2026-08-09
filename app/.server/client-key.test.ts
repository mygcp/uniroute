import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-client-key-test-${randomUUID()}.db`;

type ClientKeyModule = typeof import("./client-key");
let ck: ClientKeyModule;

beforeAll(async () => {
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
    expect(stored!.key_prefix).toBe(key.slice(0, 8));
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

import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-crypto-test-${randomUUID()}.db`;

// Module di-load dinamis agar env API_KEY_SECRET dapat diubah per-case.
async function loadWithSecret(secret: string | undefined) {
  if (secret === undefined) {
    delete process.env.API_KEY_SECRET;
  } else {
    process.env.API_KEY_SECRET = secret;
  }
  const mod = await import("./key-crypto");
  return mod;
}

beforeEach(() => {
  delete process.env.API_KEY_SECRET;
});

describe("key crypto", () => {
  test("hasApiKeySecret reflects env", async () => {
    const mod = await loadWithSecret(undefined);
    expect(mod.hasApiKeySecret()).toBe(false);
    const withSecret = await loadWithSecret("ab".repeat(32));
    expect(withSecret.hasApiKeySecret()).toBe(true);
  });

  test("encryptKey returns null when no secret", async () => {
    const mod = await loadWithSecret(undefined);
    expect(mod.encryptKey("sk-hello")).toBeNull();
  });

  test("encrypt/decrypt roundtrip", async () => {
    const mod = await loadWithSecret("deadbeef".repeat(8));
    const enc = mod.encryptKey("sk-secret-value-123");
    expect(enc).not.toBeNull();
    expect(enc).not.toContain("sk-secret");
    expect(mod.decryptKey(enc!)).toBe("sk-secret-value-123");
  });

  test("produces different ciphertext per call (fresh iv)", async () => {
    const mod = await loadWithSecret("12345678".repeat(8));
    const a = mod.encryptKey("same");
    const b = mod.encryptKey("same");
    expect(a).not.toBe(b);
    expect(mod.decryptKey(a!)).toBe("same");
    expect(mod.decryptKey(b!)).toBe("same");
  });

  test("decryptKey throws when secret missing", async () => {
    const mod = await loadWithSecret("cafebabe".repeat(8));
    const enc = mod.encryptKey("secret")!;
    const noSecret = await loadWithSecret(undefined);
    expect(() => noSecret.decryptKey(enc)).toThrow();
  });

  test("decryptKey throws on corrupted data", async () => {
    const mod = await loadWithSecret("abcdef01".repeat(8));
    const enc = mod.encryptKey("secret")!;
    const corrupted = (enc.slice(0, -2) + (enc.endsWith("==") ? "A=" : "AA")).padEnd(enc.length, "A");
    expect(() => mod.decryptKey(corrupted)).toThrow();
  });

  test("encrypted value depends on the secret", async () => {
    const modA = await loadWithSecret("11111111".repeat(8));
    const encA = modA.encryptKey("same-key")!;
    const modB = await loadWithSecret("22222222".repeat(8));
    expect(() => modB.decryptKey(encA)).toThrow();
  });
});
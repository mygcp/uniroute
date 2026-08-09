import { describe, expect, test } from "bun:test";
import { getRegistryEntry, PROVIDER_REGISTRY } from "~/registry";

describe("provider registry", () => {
  test("has unique ids", () => {
    const ids = PROVIDER_REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("entries have required fields", () => {
    for (const entry of PROVIDER_REGISTRY) {
      expect(entry.id).toBeTruthy();
      expect(entry.alias).toBeTruthy();
      expect(["none", "apikey", "bearer", "oauth"]).toContain(entry.authType);
      expect(["openai", "anthropic", "gemini", "claude"]).toContain(entry.format);
      expect(Array.isArray(entry.models)).toBe(true);
    }
  });

  test("nvidia-nim exposes its models with context lengths", () => {
    const nim = getRegistryEntry("nvidia-nim");
    expect(nim).toBeDefined();
    const ids = nim!.models.map((m) => m.id);
    expect(ids).toContain("nvidia/llama-3.1-8b-instruct");
    expect(ids).toContain("nvidia/nv-embedqa-e5-v5");
    expect(nim!.models[0].contextLength).toBe(128000);
  });

  test("custom entry has no models", () => {
    const custom = getRegistryEntry("custom");
    expect(custom?.models).toEqual([]);
  });
});

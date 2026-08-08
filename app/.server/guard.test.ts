import { describe, expect, test } from "bun:test";
import { checkAllowlist } from "./guard";

describe("guard", () => {
  test("denies a denylisted model", () => {
    const result = checkAllowlist("nonexistent-model");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  test("allows a normal model", () => {
    const result = checkAllowlist("gpt-4o");
    expect(result.ok).toBe(true);
  });

  test("allows unknown non-denied models (permissive default)", () => {
    const result = checkAllowlist("totally-unknown-model-x");
    expect(result.ok).toBe(true);
  });
});
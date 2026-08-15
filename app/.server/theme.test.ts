import { describe, expect, test } from "bun:test";
import { decodeTheme, THEME_KEY } from "../lib/theme";

describe("theme storage", () => {
  test("decodeTheme maps stored values", () => {
    expect(decodeTheme("dark")).toBe("dark");
    expect(decodeTheme("light")).toBe("light");
    expect(decodeTheme(undefined)).toBeNull();
    expect(decodeTheme(null)).toBeNull();
    expect(decodeTheme("garbage")).toBeNull();
  });
  test("theme key constant used consistently", () => {
    expect(THEME_KEY).toBe("uniroute-theme");
  });
});
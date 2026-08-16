import { describe, expect, test } from "bun:test";
import type { TagSuggestion } from "./suggest";
import {
  addChip,
  filterSuggestions,
  joinChips,
  parseChips,
  removeChip,
} from "./tag-utils";

const OPTIONS: TagSuggestion[] = [
  { value: "gpt-4o", type: "model", provider: "openai" },
  { value: "claude-3.5", type: "model", provider: "anthropic" },
  { value: "combo:coding", type: "combo" },
];

describe("parseChips / joinChips", () => {
  test("splits commas and newlines, trims, drops empties", () => {
    expect(parseChips(" gpt-4o ,\nclaude-3.5\n, ,")).toEqual(["gpt-4o", "claude-3.5"]);
  });
  test("joinChips re-joins comma+space", () => {
    expect(joinChips(["gpt-4o", "combo:coding"])).toBe("gpt-4o, combo:coding");
  });
});

describe("addChip", () => {
  test("appends trimmed text clears input", () => {
    expect(addChip(["gpt-4o"], " claude-3.5 ")).toEqual({
      chips: ["gpt-4o", "claude-3.5"],
      clear: true,
    });
  });
  test("does not duplicate existing chips clears", () => {
    expect(addChip(["gpt-4o"], "gpt-4o")).toEqual({ chips: ["gpt-4o"], clear: true });
  });
  test("empty text ignored input kept", () => {
    expect(addChip(["gpt-4o"], "  ")).toEqual({ chips: ["gpt-4o"], clear: false });
  });
});

describe("removeChip", () => {
  test("removes chip index", () => {
    expect(removeChip(["gpt-4o", "combo:coding"], 0)).toEqual(["combo:coding"]);
  });
});

describe("filterSuggestions", () => {
  test("filters case-insensitive substring", () => {
    expect(filterSuggestions(OPTIONS, [], "gpt")).toEqual([
      { value: "gpt-4o", type: "model", provider: "openai" },
    ]);
  });
  test("hides chips added", () => {
    expect(filterSuggestions(OPTIONS, ["gpt-4o"], "")).toEqual([
      { value: "claude-3.5", type: "model", provider: "anthropic" },
      { value: "combo:coding", type: "combo" },
    ]);
  });
  test("respects limit", () => {
    expect(filterSuggestions(OPTIONS, [], "", 1)).toHaveLength(1);
  });
});
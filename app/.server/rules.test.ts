import "./test-env";
import { afterAll, describe, expect, test } from "bun:test";
import { query } from "./db";
import { evaluateRules } from "./rules";

const created: { model: string; name: string }[] = [];

type RuleInput = {
  name: string;
  rule_type: "rewrite" | "deny" | "fallback";
  priority?: number;
  is_active?: number;
  target_model?: string;
  target_provider_id?: string;
};

function modelFor(name: string): string {
  return `rules-${name}`;
}

function addRule(model: string, rule: RuleInput) {
  created.push({ model, name: rule.name });
  query(
    `INSERT INTO routing_rules
       (name, source_model, rule_type, target_model, target_provider_id, priority, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    rule.name,
    model,
    rule.rule_type,
    rule.target_model ?? null,
    rule.target_provider_id ?? null,
    rule.priority ?? 0,
    rule.is_active ?? 1,
  );
}

afterAll(() => {
  for (const { model, name } of created.splice(0)) {
    query("DELETE FROM routing_rules WHERE source_model = ? AND name = ?").run(
      model,
      name,
    );
  }
});

describe("evaluateRules", () => {
  test("deny active rule blocks", () => {
    const model = modelFor("deny");
    addRule(model, { name: "deny-1", rule_type: "deny" });
    const verdict = evaluateRules(model);
    expect(verdict.action).toBe("deny");
    if (verdict.action === "deny") expect(verdict.ruleApplied).toBe("deny-1");
  });

  test("rewrite rule returns target model", () => {
    const model = modelFor("rewrite");
    addRule(model, {
      name: "rewrite-1",
      rule_type: "rewrite",
      target_model: "llama-3.1-8b",
    });
    const verdict = evaluateRules(model);
    expect(verdict.action).toBe("rewrite");
    if (verdict.action === "rewrite") {
      expect(verdict.targetModel).toBe("llama-3.1-8b");
    }
  });

  test("fallback rule records target provider", () => {
    const model = modelFor("fallback");
    addRule(model, {
      name: "fallback-1",
      rule_type: "fallback",
      target_provider_id: "groq",
    });
    const verdict = evaluateRules(model);
    expect(verdict.action).toBe("fallback");
    if (verdict.action === "fallback") {
      expect(verdict.targetProviderId).toBe("groq");
    }
  });

  test("deny takes precedence over rewrite regardless of priority", () => {
    const model = modelFor("precedence");
    addRule(model, { name: "low-deny", rule_type: "deny", priority: 0 });
    addRule(model, {
      name: "high-rewrite",
      rule_type: "rewrite",
      priority: 100,
      target_model: "gpt-4o",
    });
    const verdict = evaluateRules(model);
    expect(verdict.action).toBe("deny");
  });

  test("inactive rules are ignored", () => {
    const model = modelFor("inactive");
    addRule(model, { name: "inactive-1", rule_type: "deny", is_active: 0 });
    expect(evaluateRules(model).action).toBe("none");
  });

  test("no rules yields none", () => {
    expect(evaluateRules("model-with-no-rules").action).toBe("none");
  });
});
import { query } from "./db";

export type RuleVerdict =
  | { action: "none" }
  | { action: "deny"; ruleApplied: string }
  | { action: "rewrite"; targetModel: string; ruleApplied: string }
  | {
      action: "fallback";
      targetProviderId?: string | null;
      ruleApplied: string;
    };

type RuleRow = {
  name: string;
  rule_type: "rewrite" | "deny" | "fallback";
  target_model: string | null;
  target_provider_id: string | null;
};

export function evaluateRules(model: string): RuleVerdict {
  const rows = (
    query(
      `SELECT name, rule_type, target_model, target_provider_id
       FROM routing_rules
       WHERE source_model = ? AND is_active = 1
       ORDER BY priority DESC, id ASC`,
    ).all(model) as unknown as RuleRow[]
  );

  for (const rule of rows) {
    if (rule.rule_type === "deny") {
      return { action: "deny", ruleApplied: rule.name };
    }
  }
  for (const rule of rows) {
    if (rule.rule_type === "rewrite" && rule.target_model) {
      return {
        action: "rewrite",
        targetModel: rule.target_model,
        ruleApplied: rule.name,
      };
    }
  }
  for (const rule of rows) {
    if (rule.rule_type === "fallback") {
      return {
        action: "fallback",
        targetProviderId: rule.target_provider_id ?? null,
        ruleApplied: rule.name,
      };
    }
  }
  return { action: "none" };
}
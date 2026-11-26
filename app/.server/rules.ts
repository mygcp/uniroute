import { getTableVersion, onDbReset, query } from "./db";

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
  source_model: string;
  name: string;
  rule_type: "rewrite" | "deny" | "fallback";
  target_model: string | null;
  target_provider_id: string | null;
};

let cachedVersion = -1;
let rulesByModel = new Map<string, RuleRow[]>();

onDbReset(() => {
  cachedVersion = -1;
  rulesByModel.clear();
});

function ensureLoaded(): void {
  const ver = getTableVersion("routing_rules");
  if (ver === cachedVersion) return;
  const rows = query(
    `SELECT source_model, name, rule_type, target_model, target_provider_id
     FROM routing_rules
     WHERE is_active = 1
     ORDER BY priority DESC, id ASC`,
  ).all() as unknown as RuleRow[];
  const next = new Map<string, RuleRow[]>();
  for (const r of rows) {
    let list = next.get(r.source_model);
    if (!list) {
      list = [];
      next.set(r.source_model, list);
    }
    list.push(r);
  }
  rulesByModel = next;
  cachedVersion = ver;
}

export function evaluateRules(model: string): RuleVerdict {
  ensureLoaded();
  const rows = rulesByModel.get(model);
  if (!rows || rows.length === 0) return { action: "none" };

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

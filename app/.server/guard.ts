import { query } from "./db";

export type AllowlistCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

export function checkAllowlist(model: string): AllowlistCheckResult {
  const row = query(
    "SELECT action, reason FROM model_allowlist WHERE model_name = ? AND action = 'deny'",
  ).get(model) as { action: string; reason: string | null } | undefined;
  if (row) {
    return { ok: false, reason: row.reason ?? "model denied" };
  }
  return { ok: true };
}
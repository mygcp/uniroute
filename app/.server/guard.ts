import { getTableVersion, onDbReset, query } from "./db";

export type AllowlistCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

let cachedVersion = -1;
let denyMap = new Map<string, string>();

onDbReset(() => {
  cachedVersion = -1;
  denyMap.clear();
});

function ensureLoaded(): void {
  const ver = getTableVersion("model_allowlist");
  if (ver === cachedVersion) return;
  const rows = query(
    "SELECT model_name, reason FROM model_allowlist WHERE action = 'deny'",
  ).all() as Array<{ model_name: string; reason: string | null }>;
  const next = new Map<string, string>();
  for (const r of rows) {
    next.set(r.model_name, r.reason ?? "model denied");
  }
  denyMap = next;
  cachedVersion = ver;
}

export function checkAllowlist(model: string): AllowlistCheckResult {
  ensureLoaded();
  const reason = denyMap.get(model);
  if (reason !== undefined) {
    return { ok: false, reason };
  }
  return { ok: true };
}

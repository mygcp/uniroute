import { listClientKeys, updateClientKey, type ClientKey } from "./client-key";
import {
  deleteKey,
  reactivateKey,
  rotateKey,
  suspendKey,
} from "./key-ops";
import { usageThisMonth } from "./key-usage";
import { computeStatus } from "./key-enforce";

export type BulkFilter = {
  status?: "active" | "suspended" | "expired";
  createdBefore?: number; // epoch seconds
};

export type BulkAction =
  | "activate"
  | "suspend"
  | "delete"
  | "rotate"
  | "extend_expiry"
  | "set_budget"
  | "export";

export type BulkData = {
  expiresAt?: number | null;
  budget?: { monthly?: number; daily?: number; per_request?: number };
};

export type BulkResult = {
  done: number;
  failed: number;
  exported?: ClientKey[];
  rotated?: Array<{ key: string; id: number }>;
};

function matchesFilter(key: ClientKey, filter: BulkFilter): boolean {
  const status = computeStatus(key, usageThisMonth(key.id));
  if (filter.status === "active" && status !== "active") return false;
  if (filter.status === "suspended" && status !== "suspended") return false;
  if (filter.status === "expired" && status !== "expired") return false;
  if (filter.createdBefore != null && (key.created_at ?? 0) >= filter.createdBefore) return false;
  return true;
}

export function applyBulk(
  filter: BulkFilter,
  action: BulkAction,
  data: BulkData = {},
  ids?: number[],
): BulkResult {
  const keys =
    ids && ids.length > 0
      ? listClientKeys().filter((k) => ids.includes(k.id))
      : listClientKeys().filter((k) => matchesFilter(k, filter));
  const result: BulkResult = { done: 0, failed: 0 };
  const errors: string[] = [];

  for (const key of keys) {
    try {
      switch (action) {
        case "activate":
          reactivateKey(key.id);
          break;
        case "suspend":
          suspendKey(key.id);
          break;
        case "delete":
          deleteKey(key.id);
          break;
        case "rotate": {
          const rotated = rotateKey(key.id);
          result.rotated ??= [];
          result.rotated.push(rotated);
          break;
        }
        case "extend_expiry":
          updateClientKey(key.id, { expiresAt: data.expiresAt ?? key.expires_at });
          break;
        case "set_budget":
          updateClientKey(key.id, {
            budget: data.budget ?? key.budget,
          });
          break;
      }
      result.done += 1;
    } catch {
      result.failed += 1;
    }
  }

  if (action === "export") {
    result.exported = keys;
  }
  void errors;
  return result;
}

export function exportKeysCsv(keys: ClientKey[]): string {
  const header = [
    "id",
    "name",
    "key_prefix",
    "status",
    "created_at",
    "expires_at",
    "blocked_at",
    "allowed_models",
    "budget",
    "quota",
  ];
  const rows = keys.map((k) =>
    [
      k.id,
      CSV(k.name),
      k.key_prefix,
      csvStatus(k),
      k.created_at,
      k.expires_at,
      k.blocked_at,
      CSV(JSON.stringify(k.allowed_models ?? [])),
      CSV(JSON.stringify(k.budget ?? {})),
      CSV(JSON.stringify(k.quota ?? {})),
    ].join(","),
  );
  return [header.join(","), ...rows].join("\n");
}

function CSV(v: string | number | null | undefined): string {
  const s = v == null ? "" : String(v);
  return `"${s.replace(/"/g, '""')}"`;
}

function csvStatus(k: ClientKey): string {
  const e = k.expires_at != null && k.expires_at < Math.floor(Date.now() / 1000);
  if (e) return "expired";
  if (k.blocked_at != null) return "suspended";
  return "active";
}
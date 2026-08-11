import { query } from "./db";
import type { ClientKey } from "./client-key";
import { usageThisMonth, type UsageSummary } from "./key-usage";

export type SharedQuotaConfig = {
  monthly_budget?: number;
  tokens_per_month?: number;
};

export type KeyGroup = {
  id: number;
  name: string;
  description: string | null;
  shared_quota: SharedQuotaConfig | null;
  created_at: number;
};

type KeyGroupRow = {
  id: number;
  name: string;
  description: string | null;
  shared_quota: string | null;
  created_at: number;
};

function toGroup(row: KeyGroupRow): KeyGroup {
  let shared: SharedQuotaConfig | null = null;
  if (row.shared_quota) {
    try {
      shared = JSON.parse(row.shared_quota) as SharedQuotaConfig;
    } catch {
      shared = null;
    }
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    shared_quota: shared,
    created_at: row.created_at,
  };
}

export function listGroups(): KeyGroup[] {
  const rows = query(
    "SELECT id, name, description, shared_quota, created_at FROM key_groups ORDER BY name ASC",
  ).all() as unknown as KeyGroupRow[];
  return rows.map(toGroup);
}

export function getGroup(id: number): KeyGroup | undefined {
  const row = query(
    "SELECT id, name, description, shared_quota, created_at FROM key_groups WHERE id = ?",
  ).get(id) as KeyGroupRow | undefined;
  return row ? toGroup(row) : undefined;
}

export function createGroup(
  name: string,
  description?: string | null,
  sharedQuota?: SharedQuotaConfig | null,
  memberIds: number[] = [],
): number {
  const quota =
    sharedQuota && Object.keys(sharedQuota).length > 0 ? JSON.stringify(sharedQuota) : null;
  const res = query(
    "INSERT INTO key_groups (name, description, shared_quota) VALUES (?, ?, ?)",
  ).run(name.trim(), description?.trim() || null, quota) as { lastInsertRowid?: number };
  const id = Number(res.lastInsertRowid);
  for (const memberId of memberIds) {
    addGroupMember(id, memberId);
  }
  return id;
}

export function updateGroup(
  id: number,
  input: { name?: string; description?: string | null; sharedQuota?: SharedQuotaConfig | null },
): void {
  const current = getGroup(id);
  if (!current) return;
  const quota =
    input.sharedQuota === undefined
      ? current.shared_quota && Object.keys(current.shared_quota).length > 0
        ? JSON.stringify(current.shared_quota)
        : null
      : input.sharedQuota && Object.keys(input.sharedQuota).length > 0
        ? JSON.stringify(input.sharedQuota)
        : null;
  query(
    "UPDATE key_groups SET name = ?, description = ?, shared_quota = ? WHERE id = ?",
  ).run(
    input.name?.trim() ? input.name.trim() : current.name,
    input.description === undefined
      ? current.description
      : input.description?.trim() || null,
    quota,
    id,
  );
}

export function deleteGroup(id: number): void {
  query("DELETE FROM key_groups WHERE id = ?").run(id);
}

export function addGroupMember(groupId: number, keyId: number): void {
  query(
    "INSERT OR IGNORE INTO key_group_members (group_id, key_id) VALUES (?, ?)",
  ).run(groupId, keyId);
}

export function removeGroupMember(groupId: number, keyId: number): void {
  query("DELETE FROM key_group_members WHERE group_id = ? AND key_id = ?").run(groupId, keyId);
}

export function setGroupMembers(groupId: number, keyIds: number[]): void {
  query("DELETE FROM key_group_members WHERE group_id = ?").run(groupId);
  for (const keyId of keyIds) addGroupMember(groupId, keyId);
}

export function groupMembers(groupId: number): number[] {
  const rows = query(
    "SELECT key_id FROM key_group_members WHERE group_id = ?",
  ).all(groupId) as unknown as { key_id: number }[];
  return rows.map((r) => r.key_id);
}

export function groupsOfKey(keyId: number): KeyGroup[] {
  const rows = query(
    `SELECT g.id, g.name, g.description, g.shared_quota, g.created_at
     FROM key_groups g
     JOIN key_group_members m ON m.group_id = g.id
     WHERE m.key_id = ?`,
  ).all(keyId) as unknown as KeyGroupRow[];
  return rows.map(toGroup);
}

/** Agregasi usage seluruh anggota grup (untuk shared quota). */
export function groupUsage(group: KeyGroup): UsageSummary {
  const members = groupMembers(group.id);
  let total: UsageSummary = { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 };
  for (const keyId of members) {
    const u = usageThisMonth(keyId);
    total.requests += u.requests;
    total.promptTokens += u.promptTokens;
    total.completionTokens += u.completionTokens;
    total.cost += u.cost;
  }
  return total;
}

export type GroupQuotaCheck =
  | { ok: true }
  | { ok: false; reason: string };

export function checkGroupSharedQuota(key: ClientKey): GroupQuotaCheck {
  const groups = groupsOfKey(key.id);
  for (const group of groups) {
    const quota = group.shared_quota;
    if (!quota || Object.keys(quota).length === 0) continue;
    const usage = groupUsage(group);
    if (quota.monthly_budget != null && usage.cost >= quota.monthly_budget) {
      return { ok: false, reason: "group shared budget exceeded" };
    }
    if (
      quota.tokens_per_month != null &&
      usage.promptTokens + usage.completionTokens >= quota.tokens_per_month
    ) {
      return { ok: false, reason: "group shared token quota exceeded" };
    }
  }
  return { ok: true };
}
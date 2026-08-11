import { Form } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/api-manager.groups";
import { Users, Trash2, Plus } from "lucide-react";
import {
  listGroups,
  createGroup,
  deleteGroup,
  updateGroup,
  setGroupMembers,
  groupMembers,
  groupUsage,
  type KeyGroup,
} from "../.server/key-groups";
import { listClientKeys } from "../.server/client-key";

export function loader() {
  const keys = listClientKeys().map((k) => ({ id: k.id, name: k.name, masked: `${k.key_prefix}…${k.key_hash.slice(0, 4)}` }));
  const groups = listGroups().map((g) => ({
    group: g,
    members: groupMembers(g.id),
    usage: groupUsage(g),
  }));
  return { keys, groups };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const num = (name: string): number | undefined => {
    const raw = String(form.get(name) ?? "").trim();
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  if (intent === "create") {
    createGroup(
      String(form.get("name") ?? "").trim(),
      String(form.get("description") ?? "").trim() || null,
      {
        monthly_budget: num("budget"),
        tokens_per_month: num("tokens"),
      },
      (String(form.get("member_ids") ?? "")
        .split(",")
        .map((s) => Number(s))
        .filter((n) => n > 0)),
    );
    return null;
  }
  if (intent === "delete") {
    deleteGroup(Number(form.get("id")));
    return null;
  }
  if (intent === "update") {
    updateGroup(Number(form.get("id")), {
      sharedQuota: { monthly_budget: num("budget"), tokens_per_month: num("tokens") },
    });
    return null;
  }
  if (intent === "members") {
    const gid = Number(form.get("id"));
    const memberIds = String(form.get("member_ids") ?? "")
      .split(",")
      .map((s) => Number(s))
      .filter((n) => n > 0);
    setGroupMembers(gid, memberIds);
    return null;
  }
  return null;
}

const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
const labelClass = "mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300";

export default function Groups({ loaderData }: Route.ComponentProps) {
  const { keys, groups } = loaderData;
  const [creating, setCreating] = useState(false);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
          <Users size={24} /> API Key Groups / Teams
        </h1>
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus size={16} /> New Group
        </button>
      </div>

      {creating ? (
        <Form method="post" className="mb-6 space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <input type="hidden" name="intent" value="create" />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass}>Group name</label>
              <input name="name" required className={inputClass} placeholder="engineering-team" />
            </div>
            <div>
              <label className={labelClass}>Description</label>
              <input name="description" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Shared budget ($/month)</label>
              <input name="budget" type="number" step="any" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Shared tokens/month</label>
              <input name="tokens" type="number" className={inputClass} />
            </div>
          </div>
          <div>
            <label className={labelClass}>Members</label>
            <MemberSelect name="member_ids" keys={keys} />
          </div>
          <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
            Create Group
          </button>
        </Form>
      ) : null}

      <div className="space-y-4">
        {groups.map(({ group, members, usage }) => {
          const quota = group.shared_quota;
          const budgetPct =
            quota?.monthly_budget && quota.monthly_budget > 0
              ? Math.min(100, Math.round((usage.cost / quota.monthly_budget) * 100))
              : null;
          const tokensPct =
            quota?.tokens_per_month && quota.tokens_per_month > 0
              ? Math.min(100, Math.round(((usage.promptTokens + usage.completionTokens) / quota.tokens_per_month) * 100))
              : null;
          return (
            <div key={group.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{group.name}</h2>
                  {group.description ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400">{group.description}</p>
                  ) : null}
                </div>
                <Form method="post">
                  <input type="hidden" name="intent" value="delete" />
                  <input type="hidden" name="id" value={group.id} />
                  <button className="rounded border border-red-200 p-1 text-red-500 hover:bg-red-50 dark:border-red-900">
                    <Trash2 size={14} />
                  </button>
                </Form>
              </div>

              <div className="mb-3 grid grid-cols-2 gap-3 text-sm">
                <QuotaBox label="Shared budget" pct={budgetPct} text={quota?.monthly_budget != null ? `$${usage.cost.toFixed(2)} / $${quota.monthly_budget}` : "not set"} />
                <QuotaBox label="Shared tokens/mo" pct={tokensPct} text={quota?.tokens_per_month != null ? `${(usage.promptTokens + usage.completionTokens).toLocaleString()} / ${quota.tokens_per_month.toLocaleString()}` : "not set"} />
              </div>

              <Form method="post" className="flex flex-wrap items-center gap-2">
                <input type="hidden" name="intent" value="members" />
                <input type="hidden" name="id" value={group.id} />
                <MemberSelect name="member_ids" keys={keys} defaultValue={members} />
                <button type="submit" className="rounded-lg bg-gray-200 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600">
                  Save members
                </button>
              </Form>
            </div>
          );
        })}
        {groups.length === 0 ? (
          <div className="rounded-xl border border-gray-200 bg-white p-8 text-center text-gray-400 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            Belum ada group.
          </div>
        ) : null}
      </div>
    </div>
  );
}

function QuotaBox({ label, pct, text }: { label: string; pct: number | null; text: string }) {
  return (
    <div className="rounded-lg border border-gray-100 p-3 dark:border-gray-800">
      <p className="mb-1 text-xs uppercase text-gray-400 dark:text-gray-500">{label}</p>
      <p className="text-sm font-medium text-gray-900 dark:text-white">{text}</p>
      {pct !== null ? (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          <div className={`h-full ${pct >= 80 ? "bg-red-500" : pct >= 50 ? "bg-yellow-500" : "bg-blue-500"}`} style={{ width: `${pct}%` }} />
        </div>
      ) : null}
    </div>
  );
}

function MemberSelect({
  name,
  keys,
  defaultValue = [],
}: {
  name: string;
  keys: Array<{ id: number; name: string; masked: string }>;
  defaultValue?: number[];
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set(defaultValue));
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {keys.map((k) => (
          <label key={k.id} className="flex items-center gap-1 rounded-full border border-gray-300 px-2 py-1 text-xs dark:border-gray-600">
            <input
              type="checkbox"
              checked={selected.has(k.id)}
              onChange={() => toggle(k.id)}
            />
            {k.name} <span className="text-gray-400">{k.masked}</span>
          </label>
        ))}
      </div>
      <input type="hidden" name={name} value={Array.from(selected).join(",")} />
    </div>
  );
}
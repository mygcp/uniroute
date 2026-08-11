import { Form } from "react-router";
import { useState, type ReactNode } from "react";
import type { Route } from "./+types/api-manager";
import {
  Copy,
  Download,
  KeyRound,
  Lock,
  LockOpen,
  Plus,
  RotateCw,
  Trash2,
  Settings,
} from "lucide-react";
import { listClientKeys, isRequireApiKey, setRequireApiKey } from "../.server/client-key";
import { computeStatus, type KeyStatus } from "../.server/key-enforce";
import {
  usageThisMonth,
  usageToday,
  type UsageSummary,
} from "../.server/key-usage";
import {
  deleteKey,
  reactivateKey,
  rotateKey,
  suspendKey,
} from "../.server/key-ops";
import { applyBulk, type BulkAction } from "../.server/key-bulk";
import { decryptKey } from "../.server/key-crypto";

export function loader() {
  const keys = listClientKeys().map((k) => {
    const month = usageThisMonth(k.id);
    const today = usageToday(k.id);
    return { key: k, month, today, status: computeStatus(k, month), revealable: !!k.key_enc };
  });
  const requireApiKey = isRequireApiKey();
  const revealAllowed = process.env.ALLOW_API_KEY_REVEAL === "1";
  const total = keys.length;
  const active = keys.filter((k) => k.status === "active").length;
  const restricted = keys.filter(
    (k) => (k.key.allowed_models && k.key.allowed_models.length > 0) || k.key.strict_ip === 1,
  ).length;
  const totalRequests = keys.reduce((acc, k) => acc + k.month.requests, 0);
  return { keys, requireApiKey, revealAllowed, counts: { total, active, restricted, totalRequests } };
}

type Row = Awaited<ReturnType<typeof loader>>["keys"][number];

type Result =
  | { newlyRotated?: { key: string; id: number }[]; revealed?: { id: number; key: string } | null }
  | null;

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const has = (name: string) => form.get(name) !== null && form.get(name) !== "";

  if (intent === "require") {
    setRequireApiKey(form.get("enabled") === "1");
    return null;
  }
  const id = Number(form.get("id") ?? 0);

  if (intent === "suspend") {
    suspendKey(id);
    return null;
  }
  if (intent === "reactivate") {
    reactivateKey(id);
    return null;
  }
  if (intent === "rotate") {
    const rotated = rotateKey(id);
    return { newlyRotated: [rotated] } satisfies Result;
  }
  if (intent === "delete") {
    deleteKey(id);
    return null;
  }
  if (intent === "reveal") {
    const key = listClientKeys().find((k) => k.id === id);
    if (!key || !key.key_enc || process.env.ALLOW_API_KEY_REVEAL !== "1") {
      return { revealed: null } satisfies Result;
    }
    try {
      return { revealed: { id, key: decryptKey(key.key_enc) } } satisfies Result;
    } catch {
      return { revealed: null } satisfies Result;
    }
  }

  if (intent === "bulk") {
    const action = String(form.get("bulk_action")) as BulkAction;
    const status = String(form.get("status_filter") ?? "");
    const beforeRaw = String(form.get("created_before") ?? "").trim();
    const createdBefore = beforeRaw ? new Date(beforeRaw).getTime() / 1000 : undefined;
    const selected = String(form.get("selected_ids") ?? "")
      .split(",")
      .map((s) => Number(s))
      .filter((n) => n > 0) as number[];
    const res = applyBulk(
      {
        status: status === "any" ? undefined : (status as never),
        createdBefore,
      },
      action,
      {},
      selected.length > 0 ? selected : undefined,
    );
    if (action === "rotate") {
      return { newlyRotated: res.rotated ?? [] } satisfies Result;
    }
    return null;
  }

  return null;
}

const STATUS_STYLE: Record<KeyStatus, { label: string; cls: string }> = {
  active: { label: "🟢 Active", cls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  near_limit: { label: "🟡 Near Limit", cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" },
  suspended: { label: "🔒 Locked", cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" },
  expired: { label: "⚠️ Expired", cls: "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300" },
};

function masked(key: Row["key"]): string {
  return `${key.key_prefix}…${key.key_hash.slice(0, 4)}`;
}

function pct(value: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

export default function ApiManager({ loaderData, actionData }: Route.ComponentProps) {
  const { keys, requireApiKey, revealAllowed, counts } = loaderData;
  const result = actionData as Result | undefined;
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("any");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const filtered = keys.filter(
    (r) =>
      (statusFilter === "any" || r.status === statusFilter) &&
      (r.key.name.toLowerCase().includes(query.toLowerCase()) ||
        masked(r.key).toLowerCase().includes(query.toLowerCase())),
  );

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const reveal = result?.revealed;
  const rotated = result?.newlyRotated;

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
            <KeyRound size={24} /> API Manager
          </h1>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Kelola API key untuk semua aplikasi &amp; client.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/api-manager/templates"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Templates
          </a>
          <a
            href="/api-manager/groups"
            className="rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            Groups
          </a>
          <a
            href="/api-manager/create"
            className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            <Plus size={16} /> Create New Key
          </a>
        </div>
      </div>

      {rotated && rotated.length > 0 ? (
        <div className="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm dark:border-yellow-700 dark:bg-yellow-950/40">
          <p className="font-semibold text-yellow-800 dark:text-yellow-200">
            Key baru berikut DITAMPILKAN SEKALI — salin sekarang:
          </p>
          {rotated.map((r) => (
            <div key={r.id} className="mt-2 flex items-center gap-2">
              <code className="break-all rounded bg-white px-3 py-2 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">
                {r.key}
              </code>
              <CopyButton value={r.key} />
            </div>
          ))}
        </div>
      ) : null}

      {reveal ? (
        <div className="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm dark:border-yellow-700 dark:bg-yellow-950/40">
          <p className="font-semibold text-yellow-800 dark:text-yellow-200">
            Full key (key #{reveal.id}):
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="break-all rounded bg-white px-3 py-2 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">
              {reveal.key}
            </code>
            <CopyButton value={reveal.key} />
          </div>
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Total Keys" value={counts.total} />
        <StatCard label="Active Keys" value={counts.active} />
        <StatCard label="Restricted Keys" value={counts.restricted} />
        <StatCard label="Requests (month)" value={counts.totalRequests.toLocaleString()} />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="🔍 Search…"
          className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white sm:w-64"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        >
          <option value="any">All status</option>
          <option value="active">Active</option>
          <option value="near_limit">Near Limit</option>
          <option value="suspended">Locked</option>
          <option value="expired">Expired</option>
        </select>

        <Form method="post" className="flex items-center gap-2">
          <input type="hidden" name="intent" value="require" />
          <input type="hidden" name="enabled" value={requireApiKey ? "0" : "1"} />
          <button
            type="submit"
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              requireApiKey
                ? "bg-green-600 text-white hover:bg-green-700"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300"
            }`}
            title="Master switch: wajibkan API key untuk semua request"
          >
            Require API key: {requireApiKey ? "ON" : "OFF"}
          </button>
        </Form>
      </div>

      {selected.size > 0 ? (
        <div className="mb-4 rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-800 dark:bg-blue-950/40">
          <span className="font-medium text-blue-900 dark:text-blue-100">
            {selected.size} selected —{" "}
          </span>
          <BulkRow ids={selected} setSelected={setSelected} />
        </div>
      ) : null}

      <ExportBar />

      <div className="table-wrap">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
              <th className="py-2 pr-2">
                <input
                  type="checkbox"
                  checked={filtered.length > 0 && filtered.every((r) => selected.has(r.key.id))}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? new Set(filtered.map((r) => r.key.id))
                        : new Set(),
                    )
                  }
                />
              </th>
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Key</th>
              <th className="py-2 pr-4">Status</th>
              <th className="py-2 pr-4">Usage</th>
              <th className="py-2 pr-4">Budget</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const st = STATUS_STYLE[r.status];
              const budget = r.key.budget?.monthly;
              const usagePct =
                budget && budget > 0 ? pct(r.month.cost, budget) : null;
              return (
                <tr key={r.key.id} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-2">
                    <input
                      type="checkbox"
                      checked={selected.has(r.key.id)}
                      onChange={() => toggle(r.key.id)}
                    />
                  </td>
                  <td className="py-2 pr-4">
                    <a
                      href={`/api-manager/${r.key.id}`}
                      className="font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      {r.key.name}
                    </a>
                    {r.key.description ? (
                      <p className="text-xs text-gray-500 dark:text-gray-400">{r.key.description}</p>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-gray-500 dark:text-gray-400">
                    {masked(r.key)}
                  </td>
                  <td className="py-2 pr-4">
                    <span className={`rounded-full px-2 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                  </td>
                  <td className="py-2 pr-4 text-xs text-gray-600 dark:text-gray-300">
                    {r.month.requests.toLocaleString()} req · {r.month.cost.toFixed(4)} USD
                  </td>
                  <td className="py-2 pr-4">
                    {usagePct !== null ? (
                      <div className="w-24">
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                          <div
                            className={`h-full ${usagePct >= 80 ? "bg-red-500" : usagePct >= 50 ? "bg-yellow-500" : "bg-blue-500"}`}
                            style={{ width: `${usagePct}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-gray-500 dark:text-gray-400">{usagePct}%</span>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">—</span>
                    )}
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-1">
                      <CopyButton value={masked(r.key)} label="Copy" small />
                      <Form method="post" className="contents">
                        <input type="hidden" name="intent" value="reveal" />
                        <input type="hidden" name="id" value={r.key.id} />
                        <button
                          type="submit"
                          disabled={!revealAllowed || !r.revealable}
                          title="Reveal full key"
                          className="rounded border border-gray-300 p-1 text-gray-600 hover:bg-gray-50 disabled:opacity-30 dark:border-gray-600 dark:text-gray-300"
                        >
                          <LockOpen size={14} />
                        </button>
                      </Form>
                      <RowAction intent="rotate" id={r.key.id} title="Rotate" icon={<RotateCw size={14} />} />
                      {r.status === "suspended" ? (
                        <RowAction intent="reactivate" id={r.key.id} title="Reactivate" icon={<LockOpen size={14} />} />
                      ) : (
                        <RowAction intent="suspend" id={r.key.id} title="Suspend" icon={<Lock size={14} />} />
                      )}
                      <RowAction intent="delete" id={r.key.id} title="Delete" icon={<Trash2 size={14} />} danger />
                      <a
                        href={`/api-manager/${r.key.id}`}
                        title="Manage / Edit"
                        className="rounded border border-gray-300 p-1 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
                      >
                        <Settings size={14} />
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-gray-400 dark:text-gray-500">
                  Tidak ada API key.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <p className="text-xs uppercase text-gray-400 dark:text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}

function CopyButton({ value, label, small }: { value: string; label?: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(value);
    } catch {
      // Fallback untuk konteks non-HTTPS (LAN).
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* ignore */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <button
      type="button"
      onClick={copy}
      className={`flex items-center gap-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 ${
        small ? "p-1" : "px-2 py-1 text-xs"
      }`}
      title={label ?? "Copy"}
    >
      <Copy size={small ? 14 : 12} />
      {label && <span>{copied ? "Copied" : label}</span>}
    </button>
  );
}

function RowAction({
  intent,
  id,
  title,
  icon,
  danger,
}: {
  intent: "rotate" | "suspend" | "reactivate" | "delete";
  id: number;
  title: string;
  icon: ReactNode;
  danger?: boolean;
}) {
  const confirmMsg =
    intent === "delete"
      ? "Hapus API key ini? Tindakan tidak bisa dibatalkan."
      : intent === "rotate"
        ? "Rotasi key ini? Key lama tetap valid selama grace period."
        : intent === "suspend"
          ? "Suspend API key ini? Request dengan key ini akan ditolak."
          : null;
  return (
    <Form
      method="post"
      className="contents"
      onSubmit={
        confirmMsg
          ? (e) => {
              if (!window.confirm(confirmMsg)) e.preventDefault();
            }
          : undefined
      }
    >
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        title={title}
        className={
          danger
            ? "rounded border border-red-200 p-1 text-red-500 hover:bg-red-50 dark:border-red-900"
            : "rounded border border-gray-300 p-1 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
        }
      >
        {icon}
      </button>
    </Form>
  );
}

function BulkRow({
  ids,
  setSelected,
}: {
  ids: Set<number>;
  setSelected: (s: Set<number>) => void;
}) {
  const confirmFor = (action: string): string | null => {
    if (action === "delete") return `Hapus ${ids.size} API key? Tindakan tidak bisa dibatalkan.`;
    if (action === "suspend") return `Suspend ${ids.size} API key?`;
    if (action === "rotate") return `Rotasi ${ids.size} API key?`;
    return null;
  };
  return (
    <Form
      method="post"
      className="inline-flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        const target = (e.target as HTMLFormElement).elements.namedItem(
          "bulk_action",
        ) as HTMLButtonElement | null;
        const action = target?.value ?? "";
        const msg = confirmFor(action);
        if (msg && !window.confirm(msg)) e.preventDefault();
      }}
    >
      <input type="hidden" name="intent" value="bulk" />
      <input type="hidden" name="selected_ids" value={Array.from(ids).join(",")} />
      {["suspend", "reactivate", "rotate", "delete", "export"].map((a) => (
        <button
          key={a}
          type="submit"
          name="bulk_action"
          value={a}
          className="rounded-lg bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700"
        >
          {a}
        </button>
      ))}
      <button
        type="button"
        onClick={() => setSelected(new Set())}
        className="rounded-lg border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
      >
        Clear
      </button>
    </Form>
  );
}

function ExportBar() {
  return (
    <Form
      method="get"
      action="/api-manager/export"
      className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-3 text-sm shadow-sm dark:border-gray-800 dark:bg-gray-900"
    >
      <select
        name="status"
        className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
      >
        <option value="any">All status</option>
        <option value="active">Active</option>
        <option value="suspended">Locked</option>
        <option value="expired">Expired</option>
      </select>
      <input
        type="date"
        name="created_before"
        title="Created before (optional)"
        className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
      />
      <select
        name="format"
        className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
      >
        <option value="csv">CSV</option>
        <option value="json">JSON</option>
      </select>
      <button
        type="submit"
        className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <Download size={14} /> Export
      </button>
      <span className="text-xs text-gray-400">download CSV/JSON by filter</span>
    </Form>
  );
}
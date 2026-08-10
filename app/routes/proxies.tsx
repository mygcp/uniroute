import { Form, useFetcher } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/proxies";
import { Network, Plus, Trash2, Upload } from "lucide-react";
import { query } from "../.server/db";
import {
  assignProxies,
  deleteProxy,
  getProxy,
  listAssignments,
  listProxies,
  parseBulkProxies,
  removeProxyAssignment,
  setProxyActive,
  testProxyConnection,
  updateProxy,
  upsertProxy,
  type ProxyProtocol,
  type ProxyRow,
} from "../.server/proxy-resolver";

function strOrNull(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t === "" ? null : t;
}

export function loader() {
  const proxies = listProxies();
  const providers = query(
    "SELECT id, name FROM providers ORDER BY id",
  ).all() as unknown as { id: string; name: string }[];
  const assignments = listAssignments();
  return { proxies, providers, assignments };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "add") {
    upsertProxy({
      protocol: (form.get("protocol") as ProxyProtocol) || "http",
      host: String(form.get("host") ?? "").trim(),
      port: Number(form.get("port")),
      username: strOrNull(form.get("username")),
      password: strOrNull(form.get("password")),
    });
    return null;
  }

  if (intent === "update") {
    updateProxy(Number(form.get("id")), {
      protocol: (form.get("protocol") as ProxyProtocol) || "http",
      host: String(form.get("host") ?? "").trim(),
      port: Number(form.get("port")),
      username: strOrNull(form.get("username")),
      password: strOrNull(form.get("password")),
    });
    return null;
  }

  if (intent === "delete") {
    deleteProxy(Number(form.get("id")));
    return null;
  }

  if (intent === "toggle") {
    setProxyActive(Number(form.get("id")), form.get("is_active") === "1");
    return null;
  }

  if (intent === "test") {
    const id = Number(form.get("id"));
    const proxy = getProxy(id);
    if (!proxy) return { test: { id, ok: false, message: "Proxy tidak ditemukan" } };
    return { test: { id, ...(await testProxyConnection(proxy)) } };
  }

  if (intent === "import") {
    const { imported, skipped } = parseBulkProxies(
      String(form.get("text") ?? ""),
      listProxies(),
    );
    let insertedCount = 0;
    for (const entry of imported) {
      if (upsertProxy(entry).inserted) insertedCount += 1;
    }
    return { importSummary: { imported: insertedCount, skipped } };
  }

  if (intent === "assign") {
    const providerId = String(form.get("provider_id") ?? "").trim();
    const ids = form.getAll("proxy_id").map(Number).filter(Number.isInteger);
    if (providerId && ids.length > 0) assignProxies(providerId, ids);
    return null;
  }

  if (intent === "unassign") {
    removeProxyAssignment(
      String(form.get("provider_id")),
      Number(form.get("proxy_id")),
    );
    return null;
  }

  return null;
}

function inputClass() {
  return "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
}

export default function Proxies({ loaderData, actionData }: Route.ComponentProps) {
  const { proxies, providers, assignments } = loaderData;
  const [tab, setTab] = useState<"list" | "import" | "assign">("list");
  const [editing, setEditing] = useState<number | null>(null);
  const fetcher = useFetcher<{ test?: { id: number; ok: boolean; message: string } }>();
  const testResult = fetcher.data?.test;
  const importSummary = actionData
    ? (actionData as { importSummary?: { imported: number; skipped: string[] } }).importSummary
    : undefined;

  const tabBtn = (label: string, id: "list" | "import" | "assign") => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${
        tab === id
          ? "bg-blue-600 text-white"
          : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <Network size={24} /> Proxies
      </h1>
      <div className="tabs-scroll mb-6">
        {tabBtn("Daftar Proxy", "list")}
        {tabBtn("Bulk Import", "import")}
        {tabBtn("Bulk Assignment", "assign")}
      </div>

      {tab === "list" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <Form method="post" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <input type="hidden" name="intent" value="add" />
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Protocol</label>
              <select name="protocol" defaultValue="http" className={inputClass()}>
                <option value="http">http</option>
                <option value="socks5">socks5</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Host</label>
              <input name="host" required placeholder="proxy.example" className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Port</label>
              <input name="port" type="number" required defaultValue={8080} className={`${inputClass()} w-24`} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Username</label>
              <input name="username" className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Password</label>
              <input name="password" className={inputClass()} />
            </div>
            <button className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">
              <Plus size={16} /> Tambah
            </button>
          </Form>

          {proxies.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              Belum ada proxy. Tambahkan di atas atau pakai tab Bulk Import.
            </p>
          ) : (
            <div className="table-wrap">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                    <th className="py-3 pr-4">Protocol</th>
                    <th className="py-3 pr-4">Host</th>
                    <th className="py-3 pr-4">Port</th>
                    <th className="py-3 pr-4">User</th>
                    <th className="py-3 pr-4">Status</th>
                    <th className="py-3">Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  {proxies.map((p) => (
                    <ProxyRowItem
                      key={p.id}
                      proxy={p}
                      editing={editing === p.id}
                      onToggleEdit={() => setEditing(editing === p.id ? null : p.id)}
                      testResult={testResult && testResult.id === p.id ? testResult : undefined}
                      testing={fetcher.state === "submitting"}
                      fetcher={fetcher}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : tab === "import" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <Form method="post">
            <input type="hidden" name="intent" value="import" />
            <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
              Satu proxy per baris (<code>host:port</code>, <code>host:port:user:pass</code>,{" "}
              <code>protocol://user:pass@host:port</code>) atau JSON array.
            </label>
            <textarea
              name="text"
              rows={10}
              placeholder={"1.2.3.4:8080\n5.6.7.8:3128:user:pass\nsocks5://user:pass@10.0.0.1:1080"}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 font-mono text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
            />
            <div className="mt-3 flex items-center gap-3">
              <button className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white">
                <Upload size={16} /> Import
              </button>
              {importSummary ? (
                <span className="text-sm text-gray-600 dark:text-gray-300">
                  {importSummary.imported} imported, {importSummary.skipped.length} skipped
                  {importSummary.skipped.length > 0 ? (
                    <span className="mt-1 block text-xs text-gray-400">
                      {importSummary.skipped.join("; ")}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
          </Form>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <Form method="post" className="mb-4">
            <input type="hidden" name="intent" value="assign" />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <p className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Providers</p>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  {providers.map((pr) => (
                    <div key={pr.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        name="provider_id"
                        value={pr.id}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      {pr.id} <span className="text-gray-400">{pr.name}</span>
                    </div>
                  ))}
                  {providers.length === 0 ? (
                    <p className="text-xs text-gray-400">Belum ada provider.</p>
                  ) : null}
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Proxies</p>
                <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                  {proxies.map((p) => (
                    <div key={p.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                      <input
                        type="checkbox"
                        name="proxy_id"
                        value={p.id}
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      {p.protocol}://{p.host}:{p.port}
                    </div>
                  ))}
                  {proxies.length === 0 ? (
                    <p className="text-xs text-gray-400">Belum ada proxy.</p>
                  ) : null}
                </div>
              </div>
            </div>
            <button
              type="submit"
              disabled={providers.length === 0 || proxies.length === 0}
              className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Assign ke provider
            </button>
          </Form>
          <p className="mb-2 mt-6 text-sm font-semibold text-gray-900 dark:text-white">
            Assignment saat ini
          </p>
          <div className="table-wrap">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                  <th className="py-3 pr-4">Provider</th>
                  <th className="py-3 pr-4">Proxy</th>
                  <th className="py-3">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={`${a.provider_id}-${a.proxy_id}`} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">
                      {a.provider_name} <span className="text-gray-400">({a.provider_id})</span>
                    </td>
                    <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">
                      {a.protocol}://{a.host}:{a.port}
                    </td>
                    <td className="py-2">
                      <Form method="post">
                        <input type="hidden" name="intent" value="unassign" />
                        <input type="hidden" name="provider_id" value={a.provider_id} />
                        <input type="hidden" name="proxy_id" value={a.proxy_id} />
                        <button className="flex items-center gap-1 text-sm text-red-500 hover:underline dark:text-red-400">
                          <Trash2 size={14} />
                          Unassign
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
                {assignments.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="py-6 text-center text-gray-400">
                      Belum ada assignment.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function ProxyRowItem({
  proxy,
  editing,
  onToggleEdit,
  testResult,
  testing,
  fetcher,
}: {
  proxy: ProxyRow;
  editing: boolean;
  onToggleEdit: () => void;
  testResult?: { id: number; ok: boolean; message: string };
  testing: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  return (
    <tr className="border-b border-gray-100 dark:border-gray-800">
      {editing ? (
        <td colSpan={6} className="bg-gray-50 py-3 dark:bg-gray-900/50">
          <Form method="post" className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="id" value={proxy.id} />
            <select name="protocol" defaultValue={proxy.protocol} className={inputClass() + " w-28"}>
              <option value="http">http</option>
              <option value="socks5">socks5</option>
            </select>
            <input name="host" defaultValue={proxy.host} className={`${inputClass()} w-44`} />
            <input name="port" type="number" defaultValue={proxy.port} className={`${inputClass()} w-20`} />
            <input name="username" defaultValue={proxy.username ?? ""} placeholder="user" className={`${inputClass()} w-28`} />
            <input name="password" defaultValue={proxy.password ?? ""} placeholder="pass" className={`${inputClass()} w-28`} />
            <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white">Simpan</button>
            <button type="button" onClick={onToggleEdit} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300">Batal</button>
          </Form>
        </td>
      ) : (
        <>
          <td className="py-2 pr-4">
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {proxy.protocol}
            </span>
          </td>
          <td className="py-2 pr-4 font-mono text-sm text-gray-900 dark:text-white">{proxy.host}</td>
          <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">{proxy.port}</td>
          <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{proxy.username ?? "-"}</td>
          <td className="py-2 pr-4">
            <Form method="post">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="id" value={proxy.id} />
              <input type="hidden" name="is_active" value={proxy.is_active ? 0 : 1} />
              <button
                className={`rounded-full px-2 py-0.5 text-xs ${
                  proxy.is_active
                    ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                    : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                }`}
              >
                {proxy.is_active ? "on" : "off"}
              </button>
            </Form>
          </td>
          <td className="py-2">
            <div className="flex items-center gap-2">
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="test" />
                <input type="hidden" name="id" value={proxy.id} />
                <button type="submit" disabled={testing} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
                  Test
                </button>
              </fetcher.Form>
              {testResult ? (
                <span
                  className={`text-xs ${testResult.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
                  title={testResult.message}
                >
                  {testResult.ok ? "OK" : "Gagal"}
                </span>
              ) : null}
              <button type="button" onClick={onToggleEdit} className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800">
                Edit
              </button>
              <Form method="post">
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="id" value={proxy.id} />
                <button className="text-red-600 hover:underline dark:text-red-400" title="Hapus proxy">
                  <Trash2 size={14} />
                </button>
              </Form>
            </div>
          </td>
        </>
      )}
    </tr>
  );
}

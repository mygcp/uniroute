import { Form, Link, redirect } from "react-router";
import type { Route } from "./+types/proxy-pools";
import { listPools, listProxies, createPool, deletePool } from "../.server/outbound-proxy";
import { Plus, Trash2 } from "lucide-react";

export function meta() {
  return [{ title: "Proxy Pools — UniRoute" }];
}

export async function loader() {
  return { pools: listPools(), proxies: listProxies(true) };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "delete") {
    deletePool(Number(form.get("id")));
    return redirect("/proxy-pools");
  }
  createPool({
    name: String(form.get("name") ?? ""),
    proxy_ids: form.getAll("proxy_ids").map(Number),
  });
  return redirect("/proxy-pools");
}

export default function ProxyPools({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Proxy Pools</h1>
        <Link
          to="/proxies"
          className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          ← Manage proxies
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">Pools</h2>
          {loaderData.pools.length === 0 ? (
            <p className="text-xs text-gray-400">No pools yet.</p>
          ) : (
            <ul className="space-y-2">
              {loaderData.pools.map((pool) => (
                <li
                  key={pool.id}
                  className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-600"
                >
                  <Link
                    to={`/proxy-pools/${pool.id}`}
                    className="text-sm font-medium text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
                  >
                    {pool.name}
                    <span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                      {pool.proxy_ids.length} proxies · {pool.is_active ? "active" : "inactive"}
                    </span>
                  </Link>
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={pool.id} />
                    <button
                      type="submit"
                      title="Delete pool"
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20"
                    >
                      <Trash2 size={15} />
                    </button>
                  </Form>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <Plus size={15} /> New Pool
          </h2>
          <Form method="post" className="space-y-3">
            <input
              name="name"
              required
              placeholder="Pool name"
              className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
            />
            {loaderData.proxies.length === 0 ? (
              <p className="text-xs text-gray-400">No active proxies to add.</p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
                {loaderData.proxies.map((p) => (
                  <label
                    key={p.id}
                    className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    <input
                      type="checkbox"
                      name="proxy_ids"
                      value={p.id}
                      className="rounded"
                    />
                    {p.name}{" "}
                    <span className="font-mono text-xs text-gray-400">
                      ({p.type} · {p.host}:{p.port})
                    </span>
                  </label>
                ))}
              </div>
            )}
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              Create pool
            </button>
          </Form>
        </div>
      </div>
    </div>
  );
}
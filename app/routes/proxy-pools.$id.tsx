import { Form, Link, redirect } from "react-router";
import type { Route } from "./+types/proxy-pools.$id";
import { getPool, listProxies, updatePool, deletePool } from "../.server/outbound-proxy";

export function meta() {
  return [{ title: `Pool — UniRoute` }];
}

export async function loader({ params }: Route.LoaderArgs) {
  return {
    pool: getPool(Number(params.id)) ?? null,
    proxies: listProxies(),
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const id = Number(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "delete") {
    deletePool(id);
    return redirect("/proxy-pools");
  }
  updatePool(id, {
    name: String(form.get("name") ?? ""),
    proxy_ids: form.getAll("proxy_ids").map(Number),
    is_active: form.get("is_active") === "1",
  });
  return redirect(`/proxy-pools/${id}`);
}

export default function PoolDetail({ loaderData }: Route.ComponentProps) {
  const pool = loaderData.pool;
  if (!pool) {
    return (
      <div className="mx-auto max-w-xl py-10 text-center">
        <p className="mb-4 text-gray-500 dark:text-gray-400">Pool not found.</p>
        <Link to="/proxy-pools" className="text-sm text-blue-600 hover:underline dark:text-blue-400">
          Back to pools
        </Link>
      </div>
    );
  }
  const activeIds = new Set(pool.proxy_ids);

  return (
    <div className="mx-auto max-w-xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">{pool.name}</h1>
        <Link
          to="/proxy-pools"
          className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
        >
          ← Back
        </Link>
      </div>

      <Form
        method="post"
        className="space-y-4 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800"
      >
        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
            Name
          </label>
          <input
            name="name"
            required
            defaultValue={pool.name}
            className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
            Proxies in pool (round-robin by last used)
          </label>
          {loaderData.proxies.length === 0 ? (
            <p className="text-xs text-gray-400">No proxies defined yet.</p>
          ) : (
            <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2 dark:border-gray-700">
              {loaderData.proxies.map((p) => (
                <label
                  key={p.id}
                  className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
                >
                  <input
                    type="checkbox"
                    name="proxy_ids"
                    value={p.id}
                    defaultChecked={activeIds.has(p.id)}
                    disabled={!p.is_active}
                    className="rounded"
                  />
                  {p.name}{" "}
                  <span className="font-mono text-xs text-gray-400">
                    ({p.type} · {p.host}:{p.port}
                    {p.is_active ? "" : " · inactive"})
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            name="is_active"
            type="checkbox"
            value="1"
            defaultChecked={pool.is_active}
            className="rounded"
          />
          Active
        </label>

        <div className="flex items-center gap-2 pt-2">
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save
          </button>
          <button
            type="submit"
            name="intent"
            value="delete"
            className="ml-auto rounded-lg px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
          >
            Delete
          </button>
        </div>
      </Form>
    </div>
  );
}
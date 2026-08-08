import { Form, redirect } from "react-router";
import type { Route } from "./+types/providers";
import { ProviderForm } from "../components/provider-form";
import { query } from "../.server/db";
import { reload } from "../.server/registry";

export type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  auth_type: string;
  is_active: number;
  weight: number;
  priority: number;
  current_connections: number;
  last_used_at: number;
};

export function loader({ request }: Route.LoaderArgs) {
  const editId = new URL(request.url).searchParams.get("id");
  const rows = query(
    "SELECT id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at FROM providers ORDER BY id",
  ).all() as unknown as ProviderRow[];
  const editing = editId ? rows.find((r) => r.id === editId) ?? null : null;
  return { providers: rows, editing };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "delete") {
    const id = String(form.get("id"));
    query("DELETE FROM providers WHERE id = ?").run(id);
    query("DELETE FROM models WHERE provider_id = ?").run(id);
    reload();
    return redirect("/providers");
  }

  const id = String(form.get("id") ?? "");
  const name = String(form.get("name") ?? "");
  const baseUrl = String(form.get("base_url") ?? "");
  const authType = String(form.get("auth_type") ?? "bearer");
  const weight = Number(form.get("weight") ?? 1);
  const priority = Number(form.get("priority") ?? 0);
  const isActive = form.get("is_active") === "1" ? 1 : 0;

  if (intent === "update") {
    query(
      `UPDATE providers
       SET name = ?, base_url = ?, auth_type = ?, weight = ?, priority = ?, is_active = ?
       WHERE id = ?`,
    ).run(name, baseUrl, authType, weight, priority, isActive, id);
  } else {
    query(
      `INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, baseUrl, authType, isActive, weight, priority);
  }
  reload();
  return redirect("/providers");
}

function AuthBadge({ auth }: { auth: string }) {
  return (
    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
      {auth}
    </span>
  );
}

export default function Providers({ loaderData }: Route.ComponentProps) {
  const { providers, editing } = loaderData;
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">🔌 Providers</h1>

      <h2 className="mb-3 text-lg font-semibold">
        {editing ? `Edit provider: ${editing.id}` : "Tambah provider"}
      </h2>
      <div className="mb-8">
        <ProviderForm provider={editing ?? undefined} providers={providers.map((p) => p.id)} />
      </div>

      <h2 className="mb-3 text-lg font-semibold">Daftar provider ({providers.length})</h2>
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-400">
              <th className="px-4 py-3">Provider</th>
              <th className="px-4 py-3">Base URL</th>
              <th className="px-4 py-3">Auth</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Weight</th>
              <th className="px-4 py-3">Priority</th>
              <th className="px-4 py-3">Conn</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id} className="border-b border-gray-100">
                <td className="px-4 py-3 font-medium">{p.name}</td>
                <td className="px-4 py-3 text-gray-500">{p.base_url}</td>
                <td className="px-4 py-3">
                  <AuthBadge auth={p.auth_type} />
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs ${
                      p.is_active ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-500"
                    }`}
                  >
                    {p.is_active ? "active" : "inactive"}
                  </span>
                </td>
                <td className="px-4 py-3">{p.weight}</td>
                <td className="px-4 py-3">{p.priority}</td>
                <td className="px-4 py-3">{p.current_connections}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-2">
                    <a
                      href={`/providers?id=${p.id}`}
                      className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50"
                    >
                      Edit
                    </a>
                    <Form method="post" onSubmit={() => confirm(`Hapus ${p.id}?`)}>
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={p.id} />
                      <button
                        type="submit"
                        className="rounded border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    </Form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
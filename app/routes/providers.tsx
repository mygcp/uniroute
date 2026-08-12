import { Form, Outlet, redirect, useFetcher, useParams } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/providers";
import { ProviderForm } from "../components/provider-form";
import {
  PROVIDER_TEMPLATES,
  ProviderTemplateCard,
  type ProviderTemplate,
} from "../components/provider-templates";
import { query } from "../.server/db";
import { reload } from "../.server/registry";
import { getRegistryEntry } from "~/registry";
import { listApiKeys } from "../.server/credential";
import { Plug, Loader2 } from "lucide-react";

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

type KeyCountRow = {
  provider_id: string;
  c: number;
};

function testProvider(providerId: string): Promise<{ connected: number; total: number }> {
  const provider = query(
    "SELECT base_url, auth_type FROM providers WHERE id = ?",
  ).get(providerId) as { base_url: string; auth_type: string } | undefined;
  if (!provider) return Promise.resolve({ connected: 0, total: 0 });

  const entry = getRegistryEntry(providerId);
  const modelsUrl =
    entry?.modelsUrl ?? new URL("/v1/models", provider.base_url).toString();

  if (provider.auth_type === "none") {
    return (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(
          modelsUrl,
          { signal: controller.signal },
        );
        clearTimeout(timer);
        return { connected: res.ok ? 1 : 0, total: 1 };
      } catch {
        return { connected: 0, total: 1 };
      }
    })();
  }

  const keys = listApiKeys(providerId).filter((k) => k.is_active);
  if (keys.length === 0) return Promise.resolve({ connected: 0, total: 0 });

  return (async () => {
    let connected = 0;
    for (const key of keys) {
      const headers = new Headers({ "Content-Type": "application/json" });
      const authHeader = entry?.authHeader;
      const authPrefix = entry?.authPrefix ?? "";
      if (authHeader) {
        headers.set(authHeader, `${authPrefix} ${key.api_key}`.trim());
      } else if (provider.auth_type === "bearer") {
        headers.set("Authorization", `Bearer ${key.api_key}`);
      } else if (provider.auth_type === "apikey") {
        headers.set("x-goog-api-key", key.api_key);
      }
      if (entry?.headers) {
        for (const [k, v] of Object.entries(entry.headers)) {
          headers.set(k, v);
        }
      }
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const res = await fetch(
          modelsUrl,
          { headers, signal: controller.signal },
        );
        clearTimeout(timer);
        if (res.ok) connected += 1;
      } catch {
        /* skip */
      }
    }
    return { connected, total: keys.length };
  })();
}

export function loader() {
  const rows = query(
    "SELECT id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at FROM providers ORDER BY id",
  ).all() as unknown as ProviderRow[];
  const keyRows = query(
    "SELECT provider_id, COUNT(*) AS c FROM provider_credentials WHERE is_active = 1 GROUP BY provider_id",
  ).all() as unknown as KeyCountRow[];
  const keyCounts: Record<string, number> = {};
  for (const r of keyRows) keyCounts[r.provider_id] = Number(r.c);
  return { providers: rows, keyCounts };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "test") {
    const id = String(form.get("id"));
    const result = await testProvider(id);
    return { test: { id, ...result } };
  }

  if (intent === "toggle") {
    const id = String(form.get("id"));
    const isActive = Number(form.get("is_active")) === 1 ? 0 : 1;
    query("UPDATE providers SET is_active = ? WHERE id = ?").run(isActive, id);
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
    const templateId = String(form.get("template_id") ?? "");
    const entry = templateId ? getRegistryEntry(templateId) : undefined;
    if (entry && entry.models.length > 0) {
      for (const [i, m] of entry.models.entries()) {
        query(
          `INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary)
           VALUES (?, ?, ?, 1, ?)`,
        ).run(m.id, id, m.contextLength ?? null, i === 0 ? 1 : 0);
      }
    }
  }
  reload();
  return redirect("/providers");
}

function AuthBadge({ auth }: { auth: string }) {
  return (
    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
      {auth}
    </span>
  );
}

export default function Providers({ loaderData }: Route.ComponentProps) {
  const { providers, keyCounts } = loaderData;
  const [picked, setPicked] = useState<ProviderTemplate | null>(null);
  const { id } = useParams();
  const fetcher = useFetcher<{ test?: { id: string; connected: number } }>();
  const testResult = fetcher.data?.test;
  const testing = fetcher.state === "submitting";

  if (id) {
    return <Outlet />;
  }

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold text-gray-900 dark:text-white">Providers</h1>

      {picked ? (
        <>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Tambah provider
            </h2>
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              ← Pilih template lain
            </button>
          </div>
          <div className="mb-8">
            <ProviderForm template={picked} providers={providers.map((p) => p.id)} />
          </div>
        </>
      ) : (
        <>
          <h2 className="mb-1 text-lg font-semibold text-gray-900 dark:text-white">
            Tambah provider
          </h2>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            Pilih template di bawah untuk mengisi konfigurasi secara otomatis.
          </p>
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PROVIDER_TEMPLATES.map((t) => (
              <ProviderTemplateCard key={t.id} template={t} onPick={setPicked} />
            ))}
          </div>
        </>
      )}

      <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
        Daftar provider ({providers.length})
      </h2>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => (
          <div
            key={p.id}
            className={`rounded-xl border p-4 shadow-sm transition-colors ${
              p.is_active
                ? "border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
                : "border-gray-200 bg-gray-50 opacity-80 dark:border-gray-800 dark:bg-gray-900/50"
            }`}
          >
            <a href={`/providers/${p.id}`} className="block">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 dark:text-white">{p.name}</p>
                  <p className="text-xs text-gray-400">{p.id}</p>
                </div>
                <AuthBadge auth={p.auth_type} />
              </div>
              <p className="mt-2 truncate text-xs text-gray-500 dark:text-gray-400">{p.base_url}</p>
            </a>
            <div className="mt-3 flex items-center justify-between">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={Boolean(p.is_active)}
                  onChange={() => {
                    const form = document.getElementById(`toggle-${p.id}`) as HTMLFormElement | null;
                    form?.requestSubmit();
                  }}
                />
                <span className="relative h-5 w-9 rounded-full bg-gray-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:bg-green-600 peer-checked:after:translate-x-4 dark:bg-gray-600" />
                {p.is_active ? "Aktif" : "Non-aktif"}
              </label>
              <Form id={`toggle-${p.id}`} method="post" className="hidden">
                <input type="hidden" name="intent" value="toggle" />
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="is_active" value={p.is_active} />
              </Form>
            </div>
            <ProviderStatusCard
              providerId={p.id}
              keyCount={keyCounts[p.id] ?? 0}
              result={testResult && testResult.id === p.id ? testResult : undefined}
              testing={testing}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ProviderStatusCard({
  providerId,
  keyCount,
  result,
  testing,
}: {
  providerId: string;
  keyCount: number;
  result?: { id: string; connected: number };
  testing: boolean;
}) {
  const pending = testing;
  let statusText: string;
  let statusClass: string;

  if (keyCount === 0) {
    statusText = "Not connected";
    statusClass = "text-gray-400 dark:text-gray-500";
  } else if (result) {
    if (result.connected > 0) {
      statusText = `${result.connected} Connected`;
      statusClass = "text-green-600 dark:text-green-400";
    } else {
      statusText = "Error";
      statusClass = "text-red-600 dark:text-red-400";
    }
  } else {
    statusText = "Not connected";
    statusClass = "text-gray-400 dark:text-gray-500";
  }

  return (
    <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3 dark:border-gray-800">
      <span className={`flex items-center gap-1.5 text-sm font-medium ${statusClass}`}>
        {pending ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-current" />
        )}
        {statusText}
      </span>
      <Form method="post">
        <input type="hidden" name="intent" value="test" />
        <input type="hidden" name="id" value={providerId} />
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
          Test
        </button>
      </Form>
    </div>
  );
}
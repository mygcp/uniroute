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
import { Plug } from "lucide-react";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Toggle } from "../components/ui/toggle";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/feedback";

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
    "SELECT id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at FROM providers ORDER BY is_active DESC, id",
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

const AUTH_TONE: Record<string, BadgeTone> = {
  none: "neutral",
  bearer: "info",
  apikey: "primary",
};

function AuthBadge({ auth }: { auth: string }) {
  return <Badge tone={AUTH_TONE[auth] ?? "neutral"}>{auth}</Badge>;
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
      <PageHeader title="Providers" icon={<Plug size={20} />} />

      {picked ? (
        <>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-foreground">Add provider</h2>
            <button
              type="button"
              onClick={() => setPicked(null)}
              className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              ← Choose another template
            </button>
          </div>
          <div className="mb-8">
            <ProviderForm template={picked} providers={providers.map((p) => p.id)} />
          </div>
        </>
      ) : (
        <>
          <h2 className="mb-1 text-lg font-semibold text-foreground">Add provider</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Pick a template below to prefill the configuration.
          </p>
          <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {PROVIDER_TEMPLATES.map((t) => (
              <ProviderTemplateCard key={t.id} template={t} onPick={setPicked} />
            ))}
          </div>
        </>
      )}

      <h2 className="mb-3 text-lg font-semibold text-foreground">
        Providers ({providers.length})
      </h2>
      <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => (
          <Card
            key={p.id}
            className={p.is_active ? "transition-colors" : "opacity-80 transition-colors"}
          >
            <div className="flex items-start justify-between gap-3">
              <a href={`/providers/${p.id}`} className="block min-w-0">
                <p className="font-semibold text-foreground">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.id}</p>
              </a>
              <div className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-muted-foreground">{p.is_active ? "ON" : "OFF"}</span>
                <Toggle
                  checked={Boolean(p.is_active)}
                  label={`${p.is_active ? "Deactivate" : "Activate"} ${p.name}`}
                  onChange={() => {
                    const form = document.getElementById(`toggle-${p.id}`) as HTMLFormElement | null;
                    form?.requestSubmit();
                  }}
                />
                <AuthBadge auth={p.auth_type} />
              </div>
            </div>
            <a
              href={`/providers/${p.id}`}
              className="mt-2 block truncate text-xs text-muted-foreground"
            >
              {p.base_url}
            </a>
            <Form id={`toggle-${p.id}`} method="post" className="hidden">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="is_active" value={p.is_active} />
            </Form>
            <ProviderStatusCard
              providerId={p.id}
              keyCount={keyCounts[p.id] ?? 0}
              result={testResult && testResult.id === p.id ? testResult : undefined}
              testing={testing}
              fetcher={fetcher}
            />
          </Card>
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
  fetcher,
}: {
  providerId: string;
  keyCount: number;
  result?: { id: string; connected: number };
  testing: boolean;
  fetcher: ReturnType<typeof useFetcher>;
}) {
  const pending = testing;
  let statusText: string;
  let statusClass: string;

  if (keyCount === 0) {
    statusText = "no connection";
    statusClass = "text-muted-foreground";
  } else if (result) {
    if (result.connected > 0) {
      statusText = `${result.connected} Connected`;
      statusClass = "text-success";
    } else {
      statusText = "Error";
      statusClass = "text-danger";
    }
  } else {
    statusText = "Not connected";
    statusClass = "text-muted-foreground";
  }

  return (
    <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
      <span className={`flex items-center gap-1.5 text-sm font-medium ${statusClass}`}>
        {pending ? (
          <Spinner size={14} />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-current" />
        )}
        {statusText}
      </span>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="test" />
        <input type="hidden" name="id" value={providerId} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? <Spinner size={14} /> : <Plug size={14} />}
          Test
        </Button>
      </fetcher.Form>
    </div>
  );
}
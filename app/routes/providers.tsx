import { Form, Link, Outlet, redirect, useFetcher, useNavigation, useParams } from "react-router";
import { useEffect, useRef, useState } from "react";
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
import { testProviderConnection } from "../.server/provider-test";
import { Plug } from "lucide-react";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Toggle } from "../components/ui/toggle";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/feedback";
import { useToast } from "../components/ui/toast";

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
  prefix: string | null;
};

type KeyCountRow = {
  provider_id: string;
  c: number;
};

async function testProvider(providerId: string): Promise<{ connected: number; total: number }> {
  const r = await testProviderConnection(providerId);
  return { connected: r.connected, total: r.total };
}

function runAllTests(rows: ProviderRow[], keyCounts: Record<string, number>) {
  return Promise.all(
    rows.map(async (p) => {
      if (keyCounts[p.id] === 0) return null;
      const result = await testProvider(p.id);
      return [p.id, result] as const;
    }),
  ).then((results) => {
    const initialTestResults: Record<string, { connected: number; total: number }> = {};
    for (const r of results) {
      if (r) initialTestResults[r[0]] = r[1];
    }
    return initialTestResults;
  });
}

export function loader() {
  const providers = query(
    "SELECT id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at, prefix FROM providers ORDER BY is_active DESC, id",
  ).all() as unknown as ProviderRow[];
  const keyRows = query(
    "SELECT provider_id, COUNT(*) as c FROM provider_credentials WHERE is_active = 1 GROUP BY provider_id",
  ).all() as unknown as KeyCountRow[];
  const keyCounts: Record<string, number> = {};
  for (const r of keyRows) keyCounts[r.provider_id] = Number(r.c);
  return { providers, keyCounts };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "test") {
    const id = String(form.get("id"));
    const result = await testProvider(id);
    return { test: { id, ...result } };
  }

  if (intent === "test-all") {
    const rows = query(
      "SELECT id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at, prefix FROM providers ORDER BY is_active DESC, id",
    ).all() as unknown as ProviderRow[];
    const keyRows = query(
      "SELECT provider_id, COUNT(*) as c FROM provider_credentials WHERE is_active = 1 GROUP BY provider_id",
    ).all() as unknown as KeyCountRow[];
    const keyCounts: Record<string, number> = {};
    for (const r of keyRows) keyCounts[r.provider_id] = Number(r.c);
    const initialTestResults = await runAllTests(rows, keyCounts);
    return { testAll: initialTestResults };
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
  let prefix: string | null = null;
  try {
    const { normalizePrefix } = await import("../.server/provider-prefix");
    prefix = normalizePrefix(String(form.get("prefix") ?? ""));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "invalid prefix" };
  }
  // cek duplikat prefix (kecuali null)
  if (prefix) {
    const dup = query("SELECT id FROM providers WHERE prefix = ? AND id != ?").get(prefix, id) as { id: string } | undefined;
    if (dup) return { error: `prefix "${prefix}" sudah dipakai provider ${dup.id}` };
  }

  if (intent === "update") {
    query(
      `UPDATE providers
       SET name = ?, base_url = ?, auth_type = ?, weight = ?, priority = ?, is_active = ?, prefix = ?
       WHERE id = ?`,
    ).run(name, baseUrl, authType, weight, priority, isActive, prefix, id);
  } else {
    query(
      `INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority, prefix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, baseUrl, authType, isActive, weight, priority, prefix);
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

export default function Providers({ loaderData, actionData }: Route.ComponentProps) {
  const { providers, keyCounts } = loaderData;
  const [picked, setPicked] = useState<ProviderTemplate | null>(null);
  const { id } = useParams();
  const allFetcher = useFetcher<{ testAll?: Record<string, { connected: number; total: number }> }>();
  const { toast } = useToast();
  const navigation = useNavigation();

  // Create/update failures (bad prefix, duplicate prefix) return
  // { error } which was never rendered — surface it as an error toast.
  const lastProviderActionRef = useRef<typeof actionData>(undefined);
  useEffect(() => {
    if (lastProviderActionRef.current === actionData) return;
    lastProviderActionRef.current = actionData;
    const err = (actionData as { error?: unknown } | undefined)?.error;
    if (typeof err === "string" && err) {
      toast({
        title: "Save provider failed",
        description: err,
        variant: "error",
        ...(err.length > 120 ? { durationMs: 8000 } : {}),
      });
    }
  }, [actionData, toast]);

  // Toggle/create/update succeed with a redirect, so there is no payload to
  // observe. Capture the intent while navigating, then toast once idle. An
  // error return stays on the page with actionData.error (owned by the effect
  // above), so the success toast is skipped in that case.
  type PendingProviderMutation = { intent: string; id: string; name: string };
  const pendingProviderMutationRef = useRef<PendingProviderMutation | null>(null);
  if (navigation.state !== "idle" && navigation.formData) {
    const fd = navigation.formData;
    const intent = String(fd.get("intent") ?? "");
    if (intent === "toggle" || intent === "create" || intent === "update") {
      const pid = String(fd.get("id") ?? "");
      const known = providers.find((pr) => pr.id === pid);
      pendingProviderMutationRef.current = {
        intent,
        id: pid,
        name: known?.name || String(fd.get("name") ?? "").trim() || pid,
      };
    }
  }
  useEffect(() => {
    if (navigation.state !== "idle") return;
    const pending = pendingProviderMutationRef.current;
    if (!pending) return;
    pendingProviderMutationRef.current = null;
    if ((actionData as { error?: unknown } | undefined)?.error) return;
    const fresh = providers.find((pr) => pr.id === pending.id);
    const display = fresh?.name || pending.name || pending.id;
    if (pending.intent === "toggle") {
      const active = Boolean(fresh?.is_active);
      toast({ title: `Provider "${display}" ${active ? "enabled" : "disabled"}`, variant: "success" });
    } else if (pending.intent === "create") {
      toast({ title: `Provider "${display}" created`, variant: "success" });
    } else if (pending.intent === "update") {
      toast({ title: `Provider "${display}" updated`, variant: "success" });
    }
  }, [navigation.state, toast, providers, actionData]);

  // Run the (non-blocking) connection tests after the page renders so the
  // route loads instantly; statuses fill in as each test completes.
  useEffect(() => {
    const form = new FormData();
    form.set("intent", "test-all");
    allFetcher.submit(form, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
              <Link to={`/providers/${p.id}`} prefetch="intent" className="block min-w-0">
                <p className="font-semibold text-foreground">{p.name}</p>
                <p className="text-xs text-muted-foreground">{p.id}{p.prefix ? <span className="ml-1 font-mono text-primary"> · {(p.prefix ?? "").replace(/^\/+|\/+$/g, "")}/</span> : null}</p>
              </Link>
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
            <Link
              to={`/providers/${p.id}`}
              prefetch="intent"
              className="mt-2 block truncate text-xs text-muted-foreground"
            >
              {p.base_url}
            </Link>
            <Form id={`toggle-${p.id}`} method="post" className="hidden">
              <input type="hidden" name="intent" value="toggle" />
              <input type="hidden" name="id" value={p.id} />
              <input type="hidden" name="is_active" value={p.is_active} />
            </Form>
            
            <ProviderStatusCard
              providerId={p.id}
              keyCount={keyCounts[p.id] || 0}
              initialResult={allFetcher.data?.testAll?.[p.id]}
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
  initialResult,
}: {
  providerId: string;
  keyCount: number;
  initialResult?: { connected: number; total: number };
}) {
  // Fetcher milik tiap kartu: klik Test di satu kartu tidak mengganggu
  // kartu lain (dulu satu fetcher dibagi semua → semua ikut spin).
  const fetcher = useFetcher<{ test?: { id: string; connected: number } }>();
  const testResult =
    fetcher.data?.test && fetcher.data.test.id === providerId
      ? fetcher.data.test
      : undefined;
  const testing = fetcher.state !== "idle";
  const pending = testing;
  let statusText: string;
  let statusClass: string;

  if (keyCount === 0) {
    statusText = "no connection";
    statusClass = "text-muted-foreground";
  } else if (testResult) {
    if (testResult.connected > 0) {
      statusText = `${testResult.connected} Connected`;
      statusClass = "text-success";
    } else {
      statusText = "Error";
      statusClass = "text-danger";
    }
  } else if (initialResult){
    if (initialResult.connected > 0){
      statusText = `${initialResult.connected} Connected`;
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
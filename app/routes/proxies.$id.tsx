import { Form, Link, redirect, useNavigation, useSubmit } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/proxies.$id";
import { requireLoaderSession, requireSession } from "../.server/auth";
import { getProxy, updateProxy, deleteProxy } from "../.server/outbound-proxy";
import { testProxyConnection } from "../.server/proxy-resolver";
import { Network, Plug, Trash2 } from "lucide-react";
import { Button, buttonClass } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Checkbox, Input, Label, Select } from "../components/ui/field";
import { PageHeader } from "../components/ui/page-header";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/feedback";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function meta() {
  return [{ title: "Edit Proxy | UniRoute" }];
}

export async function loader({ request, params }: Route.LoaderArgs) {
  requireLoaderSession(request);
  const raw = getProxy(Number(params.id));
  if (!raw) return { proxy: null };
  const { password, password_enc, ...rest } = raw;
  return {
    proxy: {
      ...rest,
      has_password: Boolean(password || password_enc),
    },
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;
  const id = Number(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "delete") {
    deleteProxy(id);
    return redirect("/proxies");
  }

  if (intent === "test") {
    const proxy = getProxy(id);
    if (proxy) return { test: await testProxyConnection(proxy) };
    return { test: { ok: false, latencyMs: 0 } };
  }

  const rawPassword = String(form.get("password") || "");
  const clearPassword = form.get("clear_password") === "1";

  updateProxy(id, {
    name: String(form.get("name") || "").trim(),
    type: String(form.get("type")) === "socks5" ? "socks5" : "http-connect",
    host: String(form.get("host") || "").trim(),
    port: Number(form.get("port")),
    username: String(form.get("username") || "").trim() || null,
    password: clearPassword ? null : rawPassword ? rawPassword : undefined,
    is_active: form.get("is_active") === "1",
  });
  return redirect(`/proxies/${id}`);
}

export default function ProxyDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const p = loaderData.proxy;
  const test = actionData?.test;
  const { dialog, confirm } = useConfirm();
  const { toast } = useToast();
  const navigation = useNavigation();
  const submit = useSubmit();
  const [clearPassword, setClearPassword] = useState(false);

  const activeIntent =
    navigation.state !== "idle"
      ? String(navigation.formData?.get("intent") || "save")
      : null;

  const pendingIntentRef = useRef<string | null>(null);
  if (navigation.state !== "idle" && navigation.formData) {
    const raw = navigation.formData.get("intent");
    pendingIntentRef.current = raw == null || raw === "" ? "save" : String(raw);
  }
  const proxyName = p?.name ?? "Proxy";
  useEffect(() => {
    if (navigation.state !== "idle") return;
    const pending = pendingIntentRef.current;
    if (!pending) return;
    pendingIntentRef.current = null;
    if (pending === "save") {
      setClearPassword(false);
      toast({ title: `Proxy "${proxyName}" saved`, variant: "success" });
    }
  }, [navigation.state, toast, proxyName]);

  if (!p) {
    return (
      <Card className="mx-auto max-w-xl py-6">
        <EmptyState
          title="Proxy not found"
          description="This proxy may have been deleted."
          action={
            <Link
              to="/proxies"
              prefetch="intent"
              className={buttonClass("outline", "md")}
            >
              Back to Proxies
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title={p.name}
        icon={<Network size={20} />}
        subtitle={`${p.type} · ${p.host}:${p.port}`}
        backTo="/proxies"
        backLabel="Back to Proxies"
      />

      <Form method="post">
        <Card className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" required defaultValue={p.name} />
          </div>
          <div>
            <Label htmlFor="type">Protocol</Label>
            <Select id="type" name="type" defaultValue={p.type}>
              <option value="http-connect">HTTP CONNECT</option>
              <option value="socks5">SOCKS5</option>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label htmlFor="host">Host</Label>
              <Input
                id="host"
                name="host"
                required
                defaultValue={p.host}
                className="font-mono"
              />
            </div>
            <div>
              <Label htmlFor="port">Port</Label>
              <Input
                id="port"
                name="port"
                type="number"
                required
                min={1}
                max={65535}
                defaultValue={p.port}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="username">Username</Label>
              <Input
                id="username"
                name="username"
                autoComplete="off"
                defaultValue={p.username ?? ""}
              />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                placeholder="••••••••"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Leave blank to keep the existing stored password.
              </p>
              <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  name="clear_password"
                  value="1"
                  checked={clearPassword}
                  onChange={(e) => setClearPassword(e.target.checked)}
                />
                Clear stored password
              </label>
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <Checkbox name="is_active" value="1" defaultChecked={p.is_active} />
            Active
          </label>

          {test && (
            <div
              role="status"
              className={`rounded-lg border px-3 py-2 text-sm font-medium ${
                test.ok
                  ? "border-success/30 bg-success/12 text-success"
                  : "border-danger/30 bg-danger/12 text-danger"
              }`}
            >
              {test.ok ? `Connection OK · ${test.latencyMs}ms` : "Connection failed"}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <Button type="submit" disabled={activeIntent !== null}>
              {activeIntent === "save" ? <Spinner size={14} /> : null}
              {activeIntent === "save" ? "Saving…" : "Save Changes"}
            </Button>
            <Button
              type="submit"
              name="intent"
              value="test"
              variant="secondary"
              disabled={activeIntent !== null}
            >
              {activeIntent === "test" ? <Spinner size={14} /> : <Plug size={14} />}
              {activeIntent === "test" ? "Testing…" : "Test connection"}
            </Button>
            <Button
              type="button"
              variant="danger"
              className="ml-auto"
              disabled={activeIntent !== null}
              onClick={async () => {
                const ok = await confirm({
                  title: "Delete proxy?",
                  description: `Proxy "${p.name}" will be permanently removed.`,
                  confirmLabel: "Delete",
                  variant: "danger",
                });
                if (!ok) return;
                const fd = new FormData();
                fd.set("intent", "delete");
                submit(fd, { method: "post" });
              }}
            >
              <Trash2 size={14} />
              Delete
            </Button>
          </div>
        </Card>
      </Form>
      {dialog}
    </div>
  );
}

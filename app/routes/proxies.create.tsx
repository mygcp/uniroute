import { Form, redirect, Link, useNavigation } from "react-router";
import type { Route } from "./+types/proxies.create";
import { requireLoaderSession, requireSession } from "../.server/auth";
import { createProxy } from "../.server/outbound-proxy";

export function loader({ request }: Route.LoaderArgs) {
  requireLoaderSession(request);
  return null;
}
import { Button, buttonClass } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Checkbox, Input, Label, Select } from "../components/ui/field";
import { PageHeader } from "../components/ui/page-header";
import { Spinner } from "../components/ui/feedback";
import { Network } from "lucide-react";

export function meta() {
  return [{ title: "New Proxy | UniRoute" }];
}

export async function action({ request }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;
  const form = await request.formData();
  createProxy({
    name: String(form.get("name") || "").trim(),
    type: String(form.get("type")) === "socks5" ? "socks5" : "http-connect",
    host: String(form.get("host") || "").trim(),
    port: Number(form.get("port")),
    username: String(form.get("username") || "").trim() || null,
    password: String(form.get("password") || "") || null,
    is_active: form.get("is_active") === "1",
  });
  return redirect("/proxies");
}

export default function CreateProxy() {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        title="New Proxy"
        icon={<Network size={20} />}
        subtitle="Add an HTTP CONNECT or SOCKS5 outbound proxy."
        backTo="/proxies"
        backLabel="Back to Proxies"
      />

      <Form method="post">
        <Card className="space-y-4">
          <div>
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              name="name"
              required
              placeholder="e.g. US Datacenter 01"
            />
          </div>
          <div>
            <Label htmlFor="type">Protocol</Label>
            <Select id="type" name="type">
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
                placeholder="proxy.example.com"
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
                defaultValue={8080}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="username">Username (optional)</Label>
              <Input id="username" name="username" autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="password">Password (optional)</Label>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
              />
            </div>
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
            <Checkbox name="is_active" value="1" defaultChecked />
            Active
          </label>
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button type="submit" disabled={submitting}>
              {submitting ? <Spinner size={14} /> : null}
              {submitting ? "Saving…" : "Save Proxy"}
            </Button>
            <Link
              to="/proxies"
              prefetch="intent"
              className={buttonClass("outline", "md")}
            >
              Cancel
            </Link>
          </div>
        </Card>
      </Form>
    </div>
  );
}

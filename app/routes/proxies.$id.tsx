import { Form, Link, redirect, useNavigation } from "react-router";
import { useEffect, useRef } from "react";
import type { Route } from "./+types/proxies.$id";
import { getProxy, updateProxy, deleteProxy } from "../.server/outbound-proxy";
import { testProxyConnection } from "../.server/proxy-resolver";
import { Button, buttonClass } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Checkbox, Input, Label, Select } from "../components/ui/field";
import { PageHeader } from "../components/ui/page-header";
import { EmptyState } from "../components/ui/empty-state";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function meta() {
	return [{ title: "Proxy — UniRoute" }];
}

export async function loader({ params }: Route.LoaderArgs) {
	return { proxy: getProxy(Number(params.id)) ?? null };
}

export async function action({ request, params }: Route.ActionArgs) {
	const id = Number(params.id);
	const form = await request.formData();
	const intent = String(form.get("intent"));

	if (intent === "delete") {
		deleteProxy(id);
		return redirect("/proxies");
	}

	if (intent === "test") {
		const proxy = getProxy(id);
		if (proxy) return { test: await testProxyConnection(proxy) };
	}

	updateProxy(id, {
		name: String(form.get("name") || ""),
		type: String(form.get("type")) === "socks5" ? "socks5" : "http-connect",
		host: String(form.get("host") || ""),
		port: Number(form.get("port")),
		username: String(form.get("username") || "") || null,
		password: String(form.get("password") || "") || null,
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

	// The save button posts with no intent and the action answers with a
	// redirect, so there is no actionData to observe. Capture the intent
	// during the navigation and toast once it settles. "test" already renders
	// an inline result box and "delete" navigates away, so only "save" toasts.
	const pendingIntentRef = useRef<string | null>(null);
	if (navigation.state !== "idle" && navigation.formData) {
		const raw = navigation.formData.get("intent");
		pendingIntentRef.current =
			raw == null || raw === "" ? "save" : String(raw);
	}
	const proxyName = p?.name ?? "Proxy";
	useEffect(() => {
		if (navigation.state !== "idle") return;
		const pending = pendingIntentRef.current;
		if (!pending) return;
		pendingIntentRef.current = null;
		if (pending === "save") {
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
							prefetch="render"
							className={buttonClass("outline", "md")}
						>
							Back to proxies
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
				actions={
					<Link
						to="/proxies"
						prefetch="render"
						className={buttonClass("ghost", "sm")}
					>
						Back
					</Link>
				}
			/>

			<Form
				method="post"
				onSubmit={async (e) => {
					const formData = new FormData(e.currentTarget);
					if (formData.get("intent") === "delete") {
						if (
							!(await confirm({
								title: "Delete proxy?",
								description: `Proxy "${p.name}" will be permanently removed.`,
								confirmLabel: "Delete",
								variant: "danger",
							}))
						) {
							e.preventDefault();
						}
					}
				}}
			>
				<Card className="space-y-4">
					<div>
						<Label htmlFor="name">Name</Label>
						<Input id="name" name="name" required defaultValue={p.name} />
					</div>
					<div>
						<Label htmlFor="type">Type</Label>
						<Select id="type" name="type" defaultValue={p.type}>
							<option value="http-connect">HTTP CONNECT</option>
							<option value="socks5">SOCKS5</option>
						</Select>
					</div>
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
						<div className="col-span-2">
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
								Leave empty to keep the stored password; type a new one to replace
								it.
							</p>
						</div>
					</div>
					<label className="flex items-center gap-2 text-sm text-foreground">
						<Checkbox
							name="is_active"
							value="1"
							defaultChecked={p.is_active}
						/>
						Active
					</label>

					{test && (
						<div
							className={`rounded-lg px-3 py-2 text-sm ${
								test.ok ? "bg-success/15 text-success" : "bg-danger/15 text-danger"
							}`}
						>
							{test.ok ? `Connection OK · ${test.latencyMs}ms` : "Connection failed"}
						</div>
					)}

					<div className="flex flex-wrap items-center gap-2 pt-2">
						<Button type="submit">Save</Button>
						<Button type="submit" name="intent" value="test" variant="secondary">
							Test connection
						</Button>
						<Button
							type="submit"
							name="intent"
							value="delete"
							variant="outline"
							className="ml-auto text-danger"
						>
							Delete
						</Button>
					</div>
				</Card>
			</Form>
			{dialog}
		</div>
	);
}
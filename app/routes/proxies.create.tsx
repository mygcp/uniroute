import { Form, redirect, Link } from "react-router";
import type { Route } from "./+types/proxies.create";
import { createProxy } from "../.server/outbound-proxy";
import { Button, buttonClass } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Checkbox, Input, Label, Select } from "../components/ui/field";
import { PageHeader } from "../components/ui/page-header";
import { Plug } from "lucide-react";

export function meta() {
	return [{ title: "New Proxy — UniRoute" }];
}

export async function action({ request }: Route.ActionArgs) {
	const form = await request.formData();
	createProxy({
		name: String(form.get("name") || ""),
		type: String(form.get("type")) === "socks5" ? "socks5" : "http-connect",
		host: String(form.get("host") || ""),
		port: Number(form.get("port")),
		username: String(form.get("username") || "") || null,
		password: String(form.get("password") || "") || null,
		is_active: form.get("is_active") === "1",
	});
	return redirect("/proxies");
}

export default function CreateProxy() {
	return (
		<div className="mx-auto max-w-xl">
			<PageHeader
				title="New Proxy"
				icon={<Plug size={20} />}
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

			<Form method="post">
				<Card className="space-y-4">
					<div>
						<Label htmlFor="name">Name</Label>
						<Input
							id="name"
							name="name"
							required
							placeholder="e.g. Datacenter"
						/>
					</div>
					<div>
						<Label htmlFor="type">Type</Label>
						<Select id="type" name="type">
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
					<label className="flex items-center gap-2 text-sm text-foreground">
						<Checkbox name="is_active" value="1" defaultChecked />
						Active
					</label>
					<div className="flex gap-2 pt-2">
						<Button type="submit">Save</Button>
						<Link
							to="/proxies"
							prefetch="render"
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
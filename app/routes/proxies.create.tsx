import { Form, redirect, Link } from "react-router";
import type { Route } from "./+types/proxies.create";
import { createProxy } from "../.server/outbound-proxy";

export function meta() {
	return [{ title: "New Proxy — UniRoute" }];
}

export async function action({ request }: Route.ActionArgs) {
	const form = await request.formData();
	createProxy({
		name: String(form.get("name") ?? ""),
		type: String(form.get("type")) === "socks5" ? "socks5" : "http-connect",
		host: String(form.get("host") ?? ""),
		port: Number(form.get("port")),
		username: String(form.get("username") ?? "") || null,
		password: String(form.get("password") ?? "") || null,
		is_active: form.get("is_active") === "1",
	});
	return redirect("/proxies");
}

export default function CreateProxy() {
	return (
		<div className="mx-auto max-w-xl">
			<h1 className="mb-6 text-xl font-bold text-gray-900 dark:text-white">
				New Proxy
			</h1>
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
						placeholder="e.g. US Datacenter"
						className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
						Type
					</label>
					<select
						name="type"
						className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
					>
						<option value="http-connect">HTTP CONNECT</option>
						<option value="socks5">SOCKS5</option>
					</select>
				</div>
				<div className="grid grid-cols-3 gap-3">
					<div className="col-span-2">
						<label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
							Host
						</label>
						<input
							name="host"
							required
							placeholder="proxy.example.com"
							className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
						/>
					</div>
					<div>
						<label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
							Port
						</label>
						<input
							name="port"
							type="number"
							required
							min={1}
							max={65535}
							defaultValue={8080}
							className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
						/>
					</div>
				</div>
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
							Username (optional)
						</label>
						<input
							name="username"
							autoComplete="off"
							className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
						/>
					</div>
					<div>
						<label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
							Password (optional)
						</label>
						<input
							name="password"
							type="password"
							autoComplete="new-password"
							className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
						/>
					</div>
				</div>
				<label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
					<input
						name="is_active"
						type="checkbox"
						value="1"
						defaultChecked
						className="rounded"
					/>
					Active
				</label>
				<div className="flex gap-2 pt-2">
					<button
						type="submit"
						className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
					>
						Save
					</button>
					<Link
						 to="/proxies"
						className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
					>
						Cancel
					</Link>
				</div>
			</Form>
		</div>
	);
}

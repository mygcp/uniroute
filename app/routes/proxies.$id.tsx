import { Form, Link, redirect } from "react-router";
import type { Route } from "./+types/proxies.$id";
import { getProxy, updateProxy, deleteProxy } from "../.server/outbound-proxy";
import { testProxyConnection } from "../.server/proxy-resolver";

export function meta() {
	return [{ title: `Proxy — UniRoute` }];
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
		name: String(form.get("name") ?? ""),
		type: String(form.get("type")) === "socks5" ? "socks5" : "http-connect",
		host: String(form.get("host") ?? ""),
		port: Number(form.get("port")),
		username: String(form.get("username") ?? "") || null,
		password: String(form.get("password") ?? "") || null,
		is_active: form.get("is_active") === "1",
	});
	return redirect(`/proxies/${id}`);
}

export default function ProxyDetail({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const p = loaderData.proxy;
	if (!p) {
		return (
			<div className="mx-auto max-w-xl py-10 text-center">
				<p className="mb-4 text-gray-500 dark:text-gray-400">
					Proxy not found.
				</p>
				<Link
					to="/proxies"
					className="text-sm text-blue-600 hover:underline dark:text-blue-400"
				>
					Back to proxies
				</Link>
			</div>
		);
	}
	const test = actionData?.test;

	return (
		<div className="mx-auto max-w-xl">
			<div className="mb-6 flex items-center justify-between">
				<h1 className="text-xl font-bold text-gray-900 dark:text-white">
					{p.name}
				</h1>
				<Link
					to="/proxies"
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
						defaultValue={p.name}
						className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
					/>
				</div>
				<div>
					<label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
						Type
					</label>
					<select
						name="type"
						defaultValue={p.type}
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
							defaultValue={p.host}
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
							defaultValue={p.port}
							className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
						/>
					</div>
				</div>
				<div className="grid grid-cols-2 gap-3">
					<div>
						<label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
							Username
						</label>
						<input
							name="username"
							autoComplete="off"
							defaultValue={p.username ?? ""}
							className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
						/>
					</div>
					<div>
						<label className="mb-1 block text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
							Password
						</label>
						<input
							name="password"
							type="password"
							autoComplete="new-password"
							placeholder="••••••••"
							className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
						/>
						<p className="mt-1 text-[11px] text-gray-400">
							Leave empty to keep the stored password; type a new one to replace
							it.
						</p>
					</div>
				</div>
				<label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
					<input
						name="is_active"
						type="checkbox"
						value="1"
						defaultChecked={p.is_active}
						className="rounded"
					/>
					Active
				</label>

				{test && (
					<div
						className={`rounded-lg px-3 py-2 text-sm ${
							test.ok
								? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
								: "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
						}`}
					>
						{test.ok
							? `Connection OK · ${test.latencyMs}ms`
							: "Connection failed"}
					</div>
				)}

				<div className="flex flex-wrap items-center gap-2 pt-2">
					<button
						type="submit"
						className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
					>
						Save
					</button>
					<button
						type="submit"
						name="intent"
						value="test"
						className="rounded-lg bg-gray-100 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
					>
						Test connection
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

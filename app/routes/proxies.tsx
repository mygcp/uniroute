import { Form, redirect, useFetcher, Link } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/proxies";
import { query } from "../.server/db";
import {
	listProxies,
	listPools,
	listAssignments,
	getProxy,
	updateProxy,
	deleteProxy,
	createPool,
	deletePool,
	assignPool,
	unassignPool,
	bulkImportProxies,
	type ProxyType,
	type BulkProxyRow,
} from "../.server/outbound-proxy";
import { testProxyConnection } from "../.server/proxy-resolver";
import { Plus, Trash2, Plug, Download } from "lucide-react";

export function meta() {
	return [{ title: "Proxies — UniRoute" }];
}

export async function loader() {
	const providers = query(
		"SELECT id, name FROM providers ORDER BY name",
	).all() as {
		id: string;
		name: string;
	}[];
	const apiKeys = query(
		"SELECT id, name FROM client_api_keys ORDER BY name",
	).all() as {
		id: number;
		name: string;
	}[];
	return {
		proxies: listProxies(),
		pools: listPools(),
		assignments: listAssignments(),
		providers,
		apiKeys,
	};
}

function parseLine(line: string): BulkProxyRow | null {
	let type: ProxyType = "http-connect";
	let rest = line.trim();
	const scheme = rest.match(/^(socks5|http-connect):\/\//i);
	if (scheme) {
		type = scheme[1].toLowerCase() as ProxyType;
		rest = rest.slice(scheme[0].length);
	}
	let username: string | null = null;
	let password: string | null = null;
	const at = rest.lastIndexOf("@");
	if (at !== -1) {
		const creds = rest.slice(0, at);
		rest = rest.slice(at + 1);
		const colon = creds.indexOf(":");
		if (colon !== -1) {
			username = creds.slice(0, colon);
			password = creds.slice(colon + 1);
		} else {
			username = creds;
		}
	}
	const m = rest.match(/^([^:]+):(\d+)$/);
	if (!m) return null;
	return { type, host: m[1], port: Number(m[2]), username, password };
}

export async function action({ request }: Route.ActionArgs) {
	const form = await request.formData();
	const intent = String(form.get("intent"));

	if (intent === "toggle") {
		const id = Number(form.get("id"));
		const current = getProxy(id);
		if (current) updateProxy(id, { is_active: !current.is_active });
		return redirect("/proxies");
	}

	if (intent === "delete") {
		deleteProxy(Number(form.get("id")));
		return redirect("/proxies");
	}

	if (intent === "test") {
		const id = Number(form.get("id"));
		const proxy = getProxy(id);
		if (proxy) {
			return { test: { id, ...(await testProxyConnection(proxy)) } };
		}
	}

	if (intent === "create-pool") {
		createPool({ name: String(form.get("name") ?? ""), proxy_ids: [] });
		return redirect("/proxies");
	}

	if (intent === "delete-pool") {
		deletePool(Number(form.get("id")));
		return redirect("/proxies");
	}

	if (intent === "assign") {
		assignPool({
			proxyPoolId: Number(form.get("pool_id")),
			targetType: String(form.get("target_type")) as "provider" | "client_key",
			targetId: String(form.get("target_id")),
		});
		return redirect("/proxies");
	}

	if (intent === "unassign") {
		unassignPool(
			String(form.get("target_type")) as "provider" | "client_key",
			String(form.get("target_id")),
		);
		return redirect("/proxies");
	}

	if (intent === "import") {
		const text = String(form.get("text") ?? "");
		let rows: BulkProxyRow[] = [];
		try {
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed)) {
				rows = parsed
					.filter((r) => r && typeof r === "object")
					.map((r) => ({
						name: r.name ? String(r.name) : undefined,
						type: (r.type === "socks5"
							? "socks5"
							: "http-connect") as ProxyType,
						host: String(r.host ?? ""),
						port: Number(r.port),
						username: r.username != null ? String(r.username) : null,
						password: r.password != null ? String(r.password) : null,
						poolName: r.poolName ? String(r.poolName) : undefined,
					}));
			}
		} catch {
			rows = text
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l && !l.startsWith("#"))
				.map(parseLine)
				.filter((r): r is BulkProxyRow => r !== null);
		}
		return { importResult: bulkImportProxies(rows) };
	}

	return null;
}

export default function Proxies({ loaderData }: Route.ComponentProps) {
	const [tab, setTab] = useState<"list" | "import" | "assignments">("list");
	const testFetcher = useFetcher<{
		test: { id: number; ok: boolean; latencyMs: number };
	}>();
	const importFetcher = useFetcher<{
		importResult: { imported: number; errors: string[] };
	}>();

	const tabs: Array<{ key: typeof tab; label: string }> = [
		{ key: "list", label: "List" },
		{ key: "import", label: "Bulk Import" },
		{ key: "assignments", label: "Assignments" },
	];

	return (
		<div>
			<div className="mb-6 flex items-center justify-between">
				<h1 className="text-xl font-bold text-gray-900 dark:text-white">
					Proxy Engine
					<span className="ml-3 text-sm font-normal text-gray-500 dark:text-gray-400">
						HTTP CONNECT &amp; SOCKS5 outbound routing
					</span>
				</h1>
				<Link
					 to="/proxies/create"
					className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
				>
					<Plus size={16} /> New Proxy
				</Link>
			</div>

			<div className="mb-4 flex gap-2 border-b border-gray-200 dark:border-gray-700">
				{tabs.map((t) => (
					<button
						key={t.key}
						onClick={() => setTab(t.key)}
						className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
							tab === t.key
								? "border-blue-600 text-blue-600 dark:text-blue-400"
								: "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
						}`}
					>
						{t.label}
					</button>
				))}
			</div>

			{tab === "list" && (
				<div className="overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
					<table className="w-full text-left text-sm">
						<thead className="text-xs uppercase text-gray-500 dark:text-gray-400">
							<tr className="border-b border-gray-200 dark:border-gray-700">
								<th className="px-4 py-3">Name</th>
								<th className="px-4 py-3">Type</th>
								<th className="px-4 py-3">Address</th>
								<th className="px-4 py-3">Auth</th>
								<th className="px-4 py-3">Last Used</th>
								<th className="px-4 py-3">Status</th>
								<th className="px-4 py-3 text-right">Actions</th>
							</tr>
						</thead>
						<tbody>
							{loaderData.proxies.map((p) => {
								const test =
									testFetcher.data?.test?.id === p.id
										? testFetcher.data.test
										: null;
								return (
									<tr
										key={p.id}
										className="border-b border-gray-100 dark:border-gray-700"
									>
										<td className="px-4 py-3 font-medium text-gray-900 dark:text-white">
											<Link
												 to={`/proxies/${p.id}`}
												className="hover:text-blue-600 dark:hover:text-blue-400"
											>
												{p.name}
											</Link>
										</td>
										<td className="px-4 py-3">
											<span className="rounded bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
												{p.type}
											</span>
										</td>
										<td className="px-4 py-3 font-mono text-xs text-gray-700 dark:text-gray-300">
											{p.host}:{p.port}
										</td>
										<td className="px-4 py-3 text-gray-600 dark:text-gray-400">
											{p.username ? p.username : "—"}
										</td>
										<td className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
											{p.last_used_at
												? new Date(p.last_used_at).toLocaleString()
												: "never"}
										</td>
										<td className="px-4 py-3">
											<span
												className={`inline-block h-2 w-2 rounded-full ${
													p.is_active ? "bg-green-500" : "bg-red-500"
												}`}
											/>
										</td>
										<td className="px-4 py-3">
											<div className="flex items-center justify-end gap-2">
												<testFetcher.Form method="post">
													<input type="hidden" name="intent" value="test" />
													<input type="hidden" name="id" value={p.id} />
													<button
														type="submit"
														title="Test connection"
														className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-blue-600 dark:text-gray-400 dark:hover:bg-gray-700"
													>
														<Plug size={15} />
													</button>
												</testFetcher.Form>
												<Form method="post">
													<input type="hidden" name="intent" value="toggle" />
													<input type="hidden" name="id" value={p.id} />
													<input
														type="hidden"
														name="is_active"
														value={p.is_active ? "1" : "0"}
													/>
													<button
														type="submit"
														title={p.is_active ? "Deactivate" : "Activate"}
														className="h-8 rounded-lg px-2 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700"
													>
														{p.is_active ? "on" : "off"}
													</button>
												</Form>
												<Form method="post">
													<input type="hidden" name="intent" value="delete" />
													<input type="hidden" name="id" value={p.id} />
													<button
														type="submit"
														title="Delete"
														className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20"
													>
														<Trash2 size={15} />
													</button>
												</Form>
											</div>
											{test && (
												<div
													className={`mt-1 text-right text-xs ${
														test.ok
															? "text-green-600 dark:text-green-400"
															: "text-red-600 dark:text-red-400"
													}`}
												>
													{test.ok ? `OK · ${test.latencyMs}ms` : "failed"}
												</div>
											)}
										</td>
									</tr>
								);
							})}
							{loaderData.proxies.length === 0 && (
								<tr>
									<td
										colSpan={7}
										className="px-4 py-8 text-center text-sm text-gray-400"
									>
										No proxies yet. Add one or use the Bulk Import tab.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			)}

			{tab === "import" && (
				<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
					<h2 className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">
						Bulk Import
					</h2>
					<p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
						One per line:{" "}
						<code className="font-mono">[type://][user:pass@]host:port</code> —
						or a JSON array of objects. Optionally include{" "}
						<code className="font-mono">poolName</code> to group imported
						proxies into a pool.
					</p>
					<importFetcher.Form method="post" className="space-y-3">
						<input type="hidden" name="intent" value="import" />
						<textarea
							name="text"
							rows={10}
							placeholder={
								"socks5://user:pass@127.0.0.1:1080\nhttp-connect://127.0.0.1:3128\nproxy.example.com:8080"
							}
							className="w-full rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
						/>
						<button
							type="submit"
							className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
						>
							<Download size={15} /> Import
						</button>
					</importFetcher.Form>
					{importFetcher.data?.importResult && (
						<div className="mt-4 rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900">
							<span className="font-semibold text-green-600 dark:text-green-400">
								{importFetcher.data.importResult.imported} imported
							</span>
							{importFetcher.data.importResult.errors.length > 0 && (
								<ul className="mt-1 list-disc pl-4 text-red-600 dark:text-red-400">
									{importFetcher.data.importResult.errors.map((e, i) => (
										<li key={i}>{e}</li>
									))}
								</ul>
							)}
						</div>
					)}
				</div>
			)}

			{tab === "assignments" && (
				<div className="space-y-6">
					<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
						<h2 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">
							Pools
						</h2>
						{loaderData.pools.length === 0 ? (
							<p className="text-xs text-gray-400">
								No pools. Create one below.
							</p>
						) : (
							<ul className="space-y-2">
								{loaderData.pools.map((pool) => (
									<li
										key={pool.id}
										className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 dark:border-gray-600"
									>
										<div>
											<Link
												 to={`/proxy-pools/${pool.id}`}
												className="text-sm font-medium text-gray-900 hover:text-blue-600 dark:text-white dark:hover:text-blue-400"
											>
												{pool.name}
											</Link>
											<span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
												{pool.proxy_ids.length} proxies ·{" "}
												{pool.is_active ? "active" : "inactive"}
											</span>
										</div>
										<Form method="post">
											<input type="hidden" name="intent" value="delete-pool" />
											<input type="hidden" name="id" value={pool.id} />
											<button
												type="submit"
												title="Delete pool"
												className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20"
											>
												<Trash2 size={15} />
											</button>
										</Form>
									</li>
								))}
							</ul>
						)}
						<Form method="post" className="mt-4 flex gap-2">
							<input type="hidden" name="intent" value="create-pool" />
							<input
								name="name"
								placeholder="Pool name"
								className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							/>
							<button
								type="submit"
								className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-600"
							>
								Create pool
							</button>
						</Form>
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
						<h2 className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">
							Assignments
						</h2>
						<p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
							Priority: client key → provider → direct.
						</p>
						{loaderData.assignments.length === 0 ? (
							<p className="text-xs text-gray-400">Nothing assigned yet.</p>
						) : (
							<table className="w-full text-left text-sm">
								<thead className="text-xs uppercase text-gray-500 dark:text-gray-400">
									<tr className="border-b border-gray-200 dark:border-gray-700">
										<th className="px-2 py-2">Target</th>
										<th className="px-2 py-2">Kind</th>
										<th className="px-2 py-2">Pool</th>
										<th className="px-2 py-2 text-right">Actions</th>
									</tr>
								</thead>
								<tbody>
									{loaderData.assignments.map((a, i) => {
										const pool = loaderData.pools.find(
											(p) => p.id === a.proxy_pool_id,
										);
										const targetName =
											a.target_type === "provider"
												? loaderData.providers.find((p) => p.id === a.target_id)
														?.name
												: loaderData.apiKeys.find(
														(k) => String(k.id) === a.target_id,
													)?.name;
										return (
											<tr
												key={i}
												className="border-b border-gray-100 dark:border-gray-700"
											>
												<td className="px-2 py-2 text-gray-900 dark:text-white">
													{targetName ?? a.target_id}
												</td>
												<td className="px-2 py-2 text-xs text-gray-500 dark:text-gray-400">
													{a.target_type}
												</td>
												<td className="px-2 py-2 text-gray-700 dark:text-gray-300">
													{pool?.name ?? a.proxy_pool_id}
												</td>
												<td className="px-2 py-2 text-right">
													<Form method="post">
														<input
															type="hidden"
															name="intent"
															value="unassign"
														/>
														<input
															type="hidden"
															name="target_type"
															value={a.target_type}
														/>
														<input
															type="hidden"
															name="target_id"
															value={a.target_id}
														/>
														<button
															type="submit"
															className="text-xs font-medium text-red-600 hover:underline dark:text-red-400"
														>
															remove
														</button>
													</Form>
												</td>
											</tr>
										);
									})}
								</tbody>
							</table>
						)}
						<Form
							method="post"
							className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-4"
						>
							<input type="hidden" name="intent" value="assign" />
							<select
								name="target_type"
								defaultValue="provider"
								className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							>
								<option value="provider">Provider</option>
								<option value="client_key">API Key</option>
							</select>
							<select
								name="target_id"
								className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							>
								{loaderData.providers.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</select>
							<select
								name="pool_id"
								className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							>
								{loaderData.pools.map((pool) => (
									<option key={pool.id} value={pool.id}>
										{pool.name}
									</option>
								))}
							</select>
							<button
								type="submit"
								className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
							>
								Assign
							</button>
						</Form>
					</div>
				</div>
			)}
		</div>
	);
}

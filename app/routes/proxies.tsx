import { Form, Link, redirect, useFetcher } from "react-router";
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
	createProxy,
	updatePool,
	getGlobalProxyPool,
	setGlobalProxyPool,
	type ProxyType,
	type BulkProxyRow,
	type ProxyConfig,
} from "../.server/outbound-proxy";
import { testProxyConnection } from "../.server/proxy-resolver";
import { Plus, Trash2, Plug, Download, Globe, RefreshCw } from "lucide-react";

export function meta() {
	return [{ title: "Proxies — UniRoute" }];
}

// ---------------------------------------------------------------------------
// Free proxy list sources
// ---------------------------------------------------------------------------

type FreeSourceFormat = "text" | "geonode";

const FREE_SOURCES: Array<{
	id: string;
	label: string;
	url: string;
	format: FreeSourceFormat;
}> = [
	{
		id: "proxyscrape-http",
		label: "ProxyScrape (HTTP)",
		url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all",
		format: "text",
	},
	{
		id: "speedx-http",
		label: "TheSpeedX (HTTP)",
		url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
		format: "text",
	},
	{
		id: "speedx-socks5",
		label: "TheSpeedX (SOCKS5)",
		url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
		format: "text",
	},
	{
		id: "proxylist-download-http",
		label: "proxy-list.download (HTTP)",
		url: "https://www.proxy-list.download/api/v1/get?type=http",
		format: "text",
	},
	{
		id: "geonode",
		label: "Geonode (HTTP/SOCKS5)",
		url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc",
		format: "geonode",
	},
	{
		id: "clarketm-http",
		label: "clarketm (HTTP/HTTPS)",
		url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt",
		format: "text",
	},
	{
		id: "roosterkid-http",
		label: "openproxylist (HTTP)",
		url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTP_RAW.txt",
		format: "text",
	},
	{
		id: "roosterkid-socks5",
		label: "openproxylist (SOCKS5)",
		url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt",
		format: "text",
	},
];

export interface FreeProxyRow {
	type: ProxyType;
	host: string;
	port: number;
	source: string;
	status?: "untested" | "ok" | "fail";
	latencyMs?: number;
	error?: string;
}

function rowKey(r: FreeProxyRow): string {
	return `${r.type}:${r.host}:${r.port}`;
}

function parseHostPort(line: string, type: ProxyType): FreeProxyRow | null {
	const m = line.trim().match(/^([^:]+):(\d+)$/);
	if (!m) return null;
	return { type, host: m[1], port: Number(m[2]), source: "sync" };
}

async function fetchFreeProxies(
	sourceUrl: string,
	type: ProxyType,
	limit: number,
	format: FreeSourceFormat = "text",
): Promise<FreeProxyRow[]> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 10_000);
	try {
		const resp = await fetch(sourceUrl, { signal: controller.signal });
		if (!resp.ok) return [];
		const text = await resp.text();
		const rows: FreeProxyRow[] = [];
		if (format === "geonode") {
			try {
				const parsed = JSON.parse(text) as {
					data?: Array<{ ip?: string; port?: number; protocols?: string[] }>;
				};
				for (const item of parsed.data ?? []) {
					if (!item.ip || !item.port) continue;
					const protocols = (item.protocols ?? []).map((p) => p.toLowerCase());
					const rowType: ProxyType = protocols.some((p) => p.includes("socks5"))
						? "socks5"
						: "http-connect";
					rows.push({
						type: rowType,
						host: item.ip,
						port: Number(item.port),
						source: "sync",
					});
					if (rows.length >= limit) break;
				}
			} catch {
				return [];
			}
		} else {
			for (const line of text.split("\n")) {
				const row = parseHostPort(line, type);
				if (row) rows.push(row);
				if (rows.length >= limit) break;
			}
		}
		return rows;
	} catch {
		return [];
	} finally {
		clearTimeout(timer);
	}
}

// ---------------------------------------------------------------------------
// Loader / action
// ---------------------------------------------------------------------------

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
		globalPoolId: getGlobalProxyPool()?.id ?? null,
	};
}

function parseLine(line: string, defaultType: ProxyType): BulkProxyRow | null {
	let type: ProxyType = defaultType;
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

async function testRows(
	rows: FreeProxyRow[],
	onResult: (
		row: FreeProxyRow,
		result: { ok: boolean; latencyMs: number },
	) => void,
): Promise<void> {
	const batch = 6;
	for (let i = 0; i < rows.length; i += batch) {
		const slice = rows.slice(i, i + batch);
		await Promise.all(
			slice.map(async (row) => {
				const proxy: ProxyConfig = {
					id: 0,
					name: `${row.host}:${row.port}`,
					type: row.type,
					host: row.host,
					port: row.port,
					username: null,
					password: null,
					password_enc: null,
					is_active: true,
					last_used_at: 0,
					success_count: 0,
					fail_count: 0,
					last_ok_at: null,
					last_latency_ms: null,
					last_error: null,
					created_at: 0,
					updated_at: 0,
				};
				const result = await testProxyConnection(proxy);
				onResult(row, result);
			}),
		);
	}
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

	if (intent === "delete-many") {
		for (const id of form.getAll("ids").map(Number)) deleteProxy(id);
		return redirect("/proxies");
	}

	if (intent === "test") {
		const id = Number(form.get("id"));
		const proxy = getProxy(id);
		if (proxy) {
			return { test: { id, ...(await testProxyConnection(proxy)) } };
		}
	}

	if (intent === "test-custom") {
		const proxy: ProxyConfig = {
			id: 0,
			name: "custom",
			type: String(form.get("type")) === "socks5" ? "socks5" : "http-connect",
			host: String(form.get("host") ?? ""),
			port: Number(form.get("port")),
			username: String(form.get("username") ?? "") || null,
			password: String(form.get("password") ?? "") || null,
			password_enc: null,
			is_active: true,
			last_used_at: 0,
			success_count: 0,
			fail_count: 0,
			last_ok_at: null,
			last_latency_ms: null,
			last_error: null,
			created_at: 0,
			updated_at: 0,
		};
		if (!proxy.host || !proxy.port)
			return { customTest: { ok: false, latencyMs: 0, status: null } };
		return { customTest: await testProxyConnection(proxy) };
	}

	// Fetch free proxies from a public list source.
	if (intent === "sync-free") {
		const sourceId = String(form.get("source") ?? "proxyscrape-http");
		const customUrl = String(form.get("custom_url") ?? "").trim();
		const limit = Math.min(Number(form.get("limit") ?? 100) || 100, 500);
		const source = FREE_SOURCES.find((s) => s.id === sourceId);
		let rows: FreeProxyRow[] = [];
		if (customUrl) {
			rows = await fetchFreeProxies(customUrl, "http-connect", limit, "text");
		} else if (source) {
			const type: ProxyType = source.id.includes("socks5")
				? "socks5"
				: "http-connect";
			rows = await fetchFreeProxies(source.url, type, limit, source.format);
		} else {
			// Auto: try every source until we get results.
			for (const s of FREE_SOURCES) {
				const t: ProxyType = s.id.includes("socks5")
					? "socks5"
					: "http-connect";
				rows = await fetchFreeProxies(s.url, t, limit, s.format);
				if (rows.length > 0) break;
			}
		}
		const deduped: FreeProxyRow[] = [];
		const seen = new Set<string>();
		for (const r of rows) {
			const k = rowKey(r);
			if (!seen.has(k)) {
				seen.add(k);
				deduped.push(r);
			}
		}
		return { freeList: deduped.slice(0, limit) };
	}

	// Test a batch of staged free proxies.
	if (intent === "test-free") {
		let rows: FreeProxyRow[];
		try {
			rows = JSON.parse(String(form.get("rows") ?? "[]")) as FreeProxyRow[];
		} catch {
			rows = [];
		}
		const results: Array<{ key: string; ok: boolean; latencyMs: number }> = [];
		await testRows(rows, (row, r) => {
			results.push({ key: rowKey(row), ok: r.ok, latencyMs: r.latencyMs });
		});
		return { freeTests: results };
	}

	// Move selected staged free proxies into the proxy list (test first).
	if (intent === "move-free") {
		let rows: FreeProxyRow[];
		try {
			rows = JSON.parse(String(form.get("rows") ?? "[]")) as FreeProxyRow[];
		} catch {
			rows = [];
		}
		const moved: string[] = [];
		const failed: Array<{ key: string; error: string }> = [];
		await testRows(rows.slice(0, 40), async (row, r) => {
			if (r.ok) {
				try {
					createProxy({
						name: `${row.host}:${row.port}`,
						type: row.type,
						host: row.host,
						port: row.port,
					});
					moved.push(rowKey(row));
				} catch (err) {
					failed.push({
						key: rowKey(row),
						error: err instanceof Error ? err.message : String(err),
					});
				}
			} else {
				failed.push({ key: rowKey(row), error: "test failed" });
			}
		});
		return { moveResult: { moved, failed } };
	}

	if (intent === "create-pool") {
		createPool({ name: String(form.get("name") ?? ""), proxy_ids: [] });
		return redirect("/proxies");
	}

	if (intent === "update-pool") {
		updatePool(Number(form.get("id")), {
			proxy_ids: form.getAll("proxy_ids").map(Number),
		});
		return redirect("/proxies");
	}

	if (intent === "delete-pool") {
		deletePool(Number(form.get("id")));
		return redirect("/proxies");
	}

	if (intent === "set-global") {
		const raw = String(form.get("pool_id") ?? "");
		setGlobalProxyPool(raw ? Number(raw) : null);
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
				.map((l) => parseLine(l, "http-connect"))
				.filter((r): r is BulkProxyRow => r !== null);
		}
		return { importResult: bulkImportProxies(rows) };
	}

	return null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type TabKey = "list" | "free" | "import" | "pools";

export default function Proxies({ loaderData }: Route.ComponentProps) {
	const [tab, setTab] = useState<TabKey>("list");
	const [staging, setStaging] = useState<FreeProxyRow[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [savedSelected, setSavedSelected] = useState<Set<number>>(new Set());

	const testFetcher = useFetcher<{
		test: { id: number; ok: boolean; latencyMs: number };
	}>();
	const importFetcher = useFetcher<{
		importResult: { imported: number; errors: string[] };
	}>();
	const syncFetcher = useFetcher<{ freeList: FreeProxyRow[] }>();
	const batchFetcher = useFetcher<{
		freeTests?: Array<{ key: string; ok: boolean; latencyMs: number }>;
		moveResult?: {
			moved: string[];
			failed: Array<{ key: string; error: string }>;
		};
	}>();
	const customTestFetcher = useFetcher<{
		customTest: { ok: boolean; latencyMs: number; status: number | null };
	}>();

	const tabs: Array<{ key: TabKey; label: string }> = [
		{ key: "list", label: "List" },
		{ key: "free", label: "Free Proxy" },
		{ key: "import", label: "Import" },
		{ key: "pools", label: "Proxy Pools" },
	];

	const globalPool = loaderData.pools.find(
		(p) => p.id === loaderData.globalPoolId,
	);
	const freeSaved = loaderData.proxies.filter((p) => !p.username);

	const syncResults = syncFetcher.data?.freeList;
	const freeTests = new Map(
		(batchFetcher.data?.freeTests ?? []).map((t) => [t.key, t]),
	);

	const markSelected = (key: string, value: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (value) next.add(key);
			else next.delete(key);
			return next;
		});
	};

	const selectedRows = staging.filter((r) => selected.has(rowKey(r)));

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
										No proxies yet. Use the Free Proxy tab to fetch some, or
										Import.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			)}

			{tab === "free" && (
				<div className="space-y-6">
					<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
						<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
							<RefreshCw size={15} /> Fetch Free Proxies
						</h2>
						<p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
							Sync fetches the latest free proxies from a public list. Test
							them, then move the good ones into your proxy list. Syncing
							replaces the previous staged list.
						</p>
						<syncFetcher.Form method="post" className="flex flex-wrap gap-2">
							<input type="hidden" name="intent" value="sync-free" />
							<select
								name="source"
								defaultValue="proxyscrape-http"
								className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							>
								<option value="auto">Auto (try all sources)</option>
								{FREE_SOURCES.map((s) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</select>
							<input
								name="custom_url"
								placeholder="or custom list URL (e.g. your Webshare download link)"
								className="min-w-52 flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							/>
							<input
								name="limit"
								type="number"
								min={1}
								max={500}
								defaultValue={100}
								title="Max proxies"
								className="w-24 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							/>
							<button
								type="submit"
								className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
							>
								<RefreshCw size={15} /> Sync
							</button>
						</syncFetcher.Form>
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
						<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
							<h2 className="text-sm font-semibold text-gray-900 dark:text-white">
								Staged Free Proxies
								<span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
									{staging.length} fetched · {selected.size} selected
								</span>
							</h2>
							{syncResults && staging.length === 0 && (
								<button
									onClick={() => {
										setStaging(syncResults);
										setSelected(new Set());
									}}
									className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-gray-600"
								>
									Load {syncResults.length} fetched
								</button>
							)}
							{staging.length > 0 && (
								<div className="flex flex-wrap items-center gap-2">
									<label className="flex items-center gap-1.5 text-xs text-gray-600 dark:text-gray-300">
										<input
											type="checkbox"
											checked={
												staging.length > 0 && selected.size === staging.length
											}
											onChange={(e) => {
												setSelected(
													e.target.checked
														? new Set(staging.map((r) => rowKey(r)))
														: new Set<string>(),
												);
											}}
											className="rounded"
										/>
										Select all
									</label>
									<batchFetcher.Form method="post">
										<input type="hidden" name="intent" value="test-free" />
										<input
											type="hidden"
											name="rows"
											value={JSON.stringify(selectedRows)}
										/>
										<button
											type="submit"
											disabled={selectedRows.length === 0}
											className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-40 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
										>
											Test selected
										</button>
									</batchFetcher.Form>
									<batchFetcher.Form method="post">
										<input type="hidden" name="intent" value="move-free" />
										<input
											type="hidden"
											name="rows"
											value={JSON.stringify(selectedRows)}
										/>
										<button
											type="submit"
											disabled={selectedRows.length === 0}
											className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:opacity-40"
										>
											<Plus size={13} /> Move to Proxy List
										</button>
									</batchFetcher.Form>
									<button
										onClick={() => {
											setStaging((prev) =>
												prev.filter((r) => !selected.has(rowKey(r))),
											);
											setSelected(new Set());
										}}
										disabled={selected.size === 0}
										className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-40 dark:bg-red-900/20 dark:text-red-400"
									>
										<Trash2 size={13} /> Delete selected
									</button>
								</div>
							)}
						</div>

						{staging.length === 0 && syncResults && (
							<div className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600 dark:bg-gray-900 dark:text-gray-300">
								{syncResults.length > 0
									? `${syncResults.length} free proxies fetched — click “Load” to review them.`
									: "No proxies found from this source. Try another source or a custom URL."}
							</div>
						)}
						{staging.length === 0 && !syncResults && (
							<p className="text-xs text-gray-400">
								Nothing staged yet — hit Sync above to fetch the latest free
								proxies.
							</p>
						)}

						{staging.length > 0 && (
							<div className="max-h-80 overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-700">
								<table className="w-full text-left text-sm">
									<thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-900 dark:text-gray-400">
										<tr className="border-b border-gray-200 dark:border-gray-700">
											<th className="w-8 px-2 py-2"></th>
											<th className="px-2 py-2">Address</th>
											<th className="px-2 py-2">Type</th>
											<th className="px-2 py-2">Test</th>
										</tr>
									</thead>
									<tbody>
										{staging.map((r) => {
											const key = rowKey(r);
											const test = freeTests.get(key);
											const status = test
												? test.ok
													? "ok"
													: "fail"
												: r.status;
											return (
												<tr
													key={key}
													className="border-b border-gray-100 dark:border-gray-700"
												>
													<td className="px-2 py-1.5">
														<input
															type="checkbox"
															checked={selected.has(key)}
															onChange={(e) =>
																markSelected(key, e.target.checked)
															}
															className="rounded"
														/>
													</td>
													<td className="px-2 py-1.5 font-mono text-xs text-gray-700 dark:text-gray-300">
														{r.host}:{r.port}
													</td>
													<td className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
														{r.type}
													</td>
													<td className="px-2 py-1.5">
														{status === "ok" && (
															<span className="text-xs font-medium text-green-600 dark:text-green-400">
																OK · {test?.latencyMs ?? r.latencyMs}ms
															</span>
														)}
														{status === "fail" && (
															<span className="text-xs text-red-600 dark:text-red-400">
																failed
															</span>
														)}
														{!status && (
															<batchFetcher.Form method="post">
																<input
																	type="hidden"
																	name="intent"
																	value="test-free"
																/>
																<input
																	type="hidden"
																	name="rows"
																	value={JSON.stringify([r])}
																/>
																<button
																	type="submit"
																	className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
																>
																	test
																</button>
															</batchFetcher.Form>
														)}
													</td>
												</tr>
											);
										})}
									</tbody>
								</table>
							</div>
						)}

						{batchFetcher.data?.moveResult && (
							<div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs dark:bg-gray-900">
								<span className="font-semibold text-green-600 dark:text-green-400">
									{batchFetcher.data.moveResult.moved.length} moved to proxy
									list
								</span>
								{batchFetcher.data.moveResult.failed.length > 0 && (
									<span className="ml-2 text-red-600 dark:text-red-400">
										{batchFetcher.data.moveResult.failed.length} failed
									</span>
								)}
							</div>
						)}
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
						<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
							<h2 className="text-sm font-semibold text-gray-900 dark:text-white">
								Test Tool
							</h2>
							<p className="text-xs text-gray-500 dark:text-gray-400">
								Test any proxy before adding — no need to save it first.
							</p>
						</div>
						<customTestFetcher.Form
							method="post"
							className="grid grid-cols-2 gap-2 sm:grid-cols-6"
						>
							<input type="hidden" name="intent" value="test-custom" />
							<select
								name="type"
								defaultValue="http-connect"
								className="rounded-lg border border-gray-300 bg-gray-50 px-2 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							>
								<option value="http-connect">CONNECT</option>
								<option value="socks5">SOCKS5</option>
							</select>
							<input
								name="host"
								required
								placeholder="host"
								className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200 sm:col-span-2"
							/>
							<input
								name="port"
								type="number"
								required
								min={1}
								max={65535}
								placeholder="port"
								className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							/>
							<input
								name="username"
								placeholder="user (opt)"
								autoComplete="off"
								className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							/>
							<button
								type="submit"
								className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-600"
							>
								Test
							</button>
						</customTestFetcher.Form>
						{customTestFetcher.data?.customTest && (
							<div
								className={`mt-3 rounded-lg px-3 py-2 text-sm ${
									customTestFetcher.data.customTest.ok
										? "bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400"
										: "bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400"
								}`}
							>
								{customTestFetcher.data.customTest.ok
									? `OK · ${customTestFetcher.data.customTest.latencyMs}ms`
									: `Failed (${customTestFetcher.data.customTest.status ?? "no response"})`}
							</div>
						)}
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
						<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
							<h2 className="text-sm font-semibold text-gray-900 dark:text-white">
								Saved Free Proxies (no auth)
								<span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
									{freeSaved.length} saved
								</span>
							</h2>
							{savedSelected.size > 0 && (
								<Form method="post">
									{[...savedSelected].map((id) => (
										<input key={id} type="hidden" name="ids" value={id} />
									))}
									<input type="hidden" name="intent" value="delete-many" />
									<button
										type="submit"
										className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400"
									>
										<Trash2 size={13} /> Delete selected ({savedSelected.size})
									</button>
								</Form>
							)}
						</div>
						{freeSaved.length === 0 ? (
							<p className="text-xs text-gray-400">
								No auth-free proxies saved yet — sync and move some above.
							</p>
						) : (
							<div className="max-h-72 overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-700">
								<table className="w-full text-left text-sm">
									<thead className="sticky top-0 bg-gray-50 text-xs uppercase text-gray-500 dark:bg-gray-900 dark:text-gray-400">
										<tr className="border-b border-gray-200 dark:border-gray-700">
											<th className="w-8 px-2 py-2"></th>
											<th className="px-2 py-2">Name</th>
											<th className="px-2 py-2">Type</th>
											<th className="px-2 py-2">Address</th>
											<th className="px-2 py-2">Status</th>
											<th className="px-2 py-2 text-right">Actions</th>
										</tr>
									</thead>
									<tbody>
										{freeSaved.map((p) => (
											<tr
												key={p.id}
												className="border-b border-gray-100 dark:border-gray-700"
											>
												<td className="px-2 py-1.5">
													<input
														type="checkbox"
														checked={savedSelected.has(p.id)}
														onChange={(e) => {
															setSavedSelected((prev) => {
																const next = new Set(prev);
																if (e.target.checked) next.add(p.id);
																else next.delete(p.id);
																return next;
															});
														}}
														className="rounded"
													/>
												</td>
												<td className="px-2 py-1.5 text-gray-900 dark:text-white">
													{p.name}
												</td>
												<td className="px-2 py-1.5 text-xs text-gray-500 dark:text-gray-400">
													{p.type}
												</td>
												<td className="px-2 py-1.5 font-mono text-xs text-gray-700 dark:text-gray-300">
													{p.host}:{p.port}
												</td>
												<td className="px-2 py-1.5">
													<span
														className={`inline-block h-2 w-2 rounded-full ${
															p.is_active ? "bg-green-500" : "bg-red-500"
														}`}
													/>
												</td>
												<td className="px-2 py-1.5 text-right">
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
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</div>
				</div>
			)}

			{tab === "import" && (
				<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
					<h2 className="mb-1 text-sm font-semibold text-gray-900 dark:text-white">
						Import
					</h2>
					<p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
						One per line:{" "}
						<code className="font-mono">[type://][user:pass@]host:port</code> —
						or a JSON array of objects. Optionally include{" "}
						<code className="font-mono">poolName</code> to group imported
						proxies into a pool. Free proxies (no auth) can also be pasted here
						as plain <code className="font-mono">host:port</code> lines.
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

			{tab === "pools" && (
				<div className="space-y-6">
					<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
						<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
							<Globe size={15} /> Global Proxy
						</h2>
						<p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
							Default fallback pool used when neither the client API key nor the
							provider has a pool assigned. Priority: client key → provider →
							global → direct.
						</p>
						<Form method="post" className="flex gap-2">
							<input type="hidden" name="intent" value="set-global" />
							<select
								name="pool_id"
								defaultValue={loaderData.globalPoolId ?? ""}
								className="flex-1 rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
							>
								<option value="">— None (direct) —</option>
								{loaderData.pools.map((pool) => (
									<option key={pool.id} value={pool.id}>
										{pool.name}
									</option>
								))}
							</select>
							<button
								type="submit"
								className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
							>
								Save
							</button>
						</Form>
						{globalPool && (
							<p className="mt-3 text-xs text-green-600 dark:text-green-400">
								Currently using pool “{globalPool.name}” (
								{globalPool.proxy_ids.length} proxies)
							</p>
						)}
					</div>

					<div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-700 dark:bg-gray-800">
						<h2 className="mb-4 text-sm font-semibold text-gray-900 dark:text-white">
							Pools
						</h2>
						{loaderData.pools.length === 0 ? (
							<p className="text-xs text-gray-400">
								No pools. Create one below.
							</p>
						) : (
							<div className="space-y-4">
								{loaderData.pools.map((pool) => (
									<div
										key={pool.id}
										className="rounded-lg border border-gray-200 p-4 dark:border-gray-600"
									>
										<div className="mb-3 flex items-center justify-between">
											<h3 className="text-sm font-semibold text-gray-900 dark:text-white">
												{pool.name}
												<span className="ml-2 text-xs font-normal text-gray-500 dark:text-gray-400">
													{pool.proxy_ids.length} proxies ·{" "}
													{pool.is_active ? "active" : "inactive"}
												</span>
											</h3>
											<Form method="post">
												<input
													type="hidden"
													name="intent"
													value="delete-pool"
												/>
												<input type="hidden" name="id" value={pool.id} />
												<button
													type="submit"
													title="Delete pool"
													className="flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/20"
												>
													<Trash2 size={15} />
												</button>
											</Form>
										</div>
										<Form method="post">
											<input type="hidden" name="intent" value="update-pool" />
											<input type="hidden" name="id" value={pool.id} />
											<div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-gray-100 p-2 dark:border-gray-700">
												{loaderData.proxies.map((p) => (
													<label
														key={p.id}
														className="flex items-center gap-2 rounded px-2 py-1 text-sm text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-700"
													>
														<input
															type="checkbox"
															name="proxy_ids"
															value={p.id}
															defaultChecked={pool.proxy_ids.includes(p.id)}
															disabled={!p.is_active}
															className="rounded"
														/>
														{p.name}{" "}
														<span className="font-mono text-xs text-gray-400">
															({p.type} · {p.host}:{p.port}
															{p.is_active ? "" : " · inactive"})
														</span>
													</label>
												))}
												{loaderData.proxies.length === 0 && (
													<p className="p-2 text-xs text-gray-400">
														No proxies defined.
													</p>
												)}
											</div>
											<button
												type="submit"
												className="mt-3 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-700 dark:bg-gray-600"
											>
												Save pool
											</button>
										</Form>
									</div>
								))}
							</div>
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
								className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
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
							Priority: client key → provider → global → direct.
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

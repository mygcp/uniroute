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
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Checkbox, Input, Select, Textarea } from "../components/ui/field";
import { Tabs } from "../components/ui/tabs";
import { Toggle } from "../components/ui/toggle";
import { PageHeader } from "../components/ui/page-header";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/feedback";
import { Table, THead, THeadCell, TRow, TCell } from "../components/ui/table";
import { useConfirm } from "../components/ui/confirm-dialog";

export function meta() {
	return [{ title: "Proxies — UniRoute" }];
}

//---------------------------------------------------------------------------
// Free proxy list sources
//---------------------------------------------------------------------------

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
		id: "clarketm",
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

//---------------------------------------------------------------------------
// Loader / action
//---------------------------------------------------------------------------

export async function loader() {
	const providers = query("SELECT id, name FROM providers ORDER BY name").all() as unknown as {
		id: string;
		name: string;
	}[];
	const apiKeys = query(
		"SELECT id, name FROM client_api_keys ORDER BY name",
	).all() as unknown as {
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
	onResult: (row: FreeProxyRow, result: { ok: boolean; latencyMs: number }) => void,
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
			host: String(form.get("host") || ""),
			port: Number(form.get("port")),
			username: String(form.get("username") || "") || null,
			password: String(form.get("password") || "") || null,
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
		if (!proxy.host || !proxy.port) {
			return { customTest: { ok: false, latencyMs: 0, status: null } };
		}
		return { customTest: await testProxyConnection(proxy) };
	}

	// Fetch free proxies from a public list source.
	if (intent === "sync-free") {
		const sourceId = String(form.get("source") || "proxyscrape-http");
		const customUrl = String(form.get("custom_url") || "").trim();
		const limit = Math.min(Number(form.get("limit") || 100) || 0, 500);
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
				const t: ProxyType = s.id.includes("socks5") ? "socks5" : "http-connect";
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
			rows = JSON.parse(String(form.get("rows") || "[]")) as FreeProxyRow[];
		} catch {
			rows = [];
		}
		const results: Array<{ key: string; ok: boolean; latencyMs: number }> = [];
		await testRows(rows, (row, r) => {
			results.push({ key: rowKey(row), ok: r.ok, latencyMs: r.latencyMs });
		});
		return { freeTests: results };
	}

	// Move selected staged free proxies to the proxy list (testing them first).
	if (intent === "move-free") {
		let rows: FreeProxyRow[];
		try {
			rows = JSON.parse(String(form.get("rows") || "[]")) as FreeProxyRow[];
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
		createPool({ name: String(form.get("name") || ""), proxy_ids: [] });
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
		const raw = String(form.get("pool_id") || "");
		setGlobalProxyPool(raw ? Number(raw) : null);
		return redirect("/proxies");
	}

	if (intent === "assign") {
		assignPool({
			proxyPoolId: Number(form.get("pool_id")),
			targetType: String(form.get("target_type")) === "provider" ? "provider" : "client_key",
			targetId: String(form.get("target_id")),
		});
		return redirect("/proxies");
	}

	if (intent === "unassign") {
		unassignPool(
			String(form.get("target_type")) === "provider" ? "provider" : "client_key",
			String(form.get("target_id")),
		);
		return redirect("/proxies");
	}

	if (intent === "import") {
		const text = String(form.get("text") || "");
		let rows: BulkProxyRow[] = [];
		try {
			const parsed = JSON.parse(text);
			if (Array.isArray(parsed)) {
				rows = parsed
					.filter((r) => typeof r === "object")
					.map((r) => ({
						name: r.name ? String(r.name) : undefined,
						type: (r.type === "socks5" ? "socks5" : "http-connect") as ProxyType,
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

//---------------------------------------------------------------------------
// Component
//---------------------------------------------------------------------------

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
		moveResult?: { moved: string[]; failed: Array<{ key: string; error: string }> };
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

	const globalPool = loaderData.pools.find((p) => p.id === loaderData.globalPoolId);
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

	const { dialog, confirm } = useConfirm();

	const syncRunning = syncFetcher.state === "submitting";
	const showLoadButton =
		syncResults &&
		syncResults.length > 0 &&
		(staging.length === 0 || staging !== syncResults);

	return (
		<div>
			<PageHeader
				title="Proxy Engine"
				icon={<Globe size={20} />}
				subtitle="HTTP CONNECT &amp; SOCKS5 outbound routing"
				actions={
					<Link
						to="/proxies/create"
						className="inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						<Plus size={16} /> New Proxy
					</Link>
				}
			/>

			<Tabs
				tabs={tabs.map((t) => t.label)}
				active={tabs.find((t) => t.key === tab)?.label ?? ""}
				onChange={(label) =>
					setTab(tabs.find((t) => t.label === label)?.key ?? "list")
				}
				className="mb-6"
			/>

			{tab === "list" && (
				<Card padded={false} className="overflow-hidden">
					{loaderData.proxies.length === 0 ? (
						<EmptyState
							icon={<Plug size={28} />}
							title="No proxies yet"
							description="Use the Free Proxy tab to fetch some, or the Import tab to paste them."
						/>
					) : (
						<Table>
							<THead>
								<TRow>
									<THeadCell>Name</THeadCell>
									<THeadCell>Type</THeadCell>
									<THeadCell>Address</THeadCell>
									<THeadCell>Auth</THeadCell>
									<THeadCell>Last Used</THeadCell>
									<THeadCell>Status</THeadCell>
									<THeadCell className="text-right">Actions</THeadCell>
								</TRow>
							</THead>
							<tbody>
								{loaderData.proxies.map((p) => {
									const test =
										testFetcher.data?.test?.id === p.id
											? testFetcher.data.test
											: null;
									return (
										<TRow key={p.id}>
											<TCell className="px-4 py-3 font-medium text-foreground">
												<Link
													to={`/proxies/${p.id}`}
													className="hover:text-primary"
												>
													{p.name}
												</Link>
											</TCell>
											<TCell className="px-4 py-3">
												<Badge tone="neutral" style="subtle">
													{p.type}
												</Badge>
											</TCell>
											<TCell className="px-4 py-3 font-mono text-xs text-muted-foreground">
												{p.host}:{p.port}
											</TCell>
											<TCell className="px-4 py-3 text-muted-foreground">
												{p.username ? p.username : "—"}
											</TCell>
											<TCell className="px-4 py-3 text-muted-foreground">
												{p.last_used_at
													? new Date(p.last_used_at).toLocaleString()
													: "never"}
											</TCell>
											<TCell className="px-4 py-3">
												<Badge
													tone={p.is_active ? "success" : "danger"}
													style="subtle"
												>
													{p.is_active ? "Active" : "Inactive"}
												</Badge>
											</TCell>
											<TCell className="px-4 py-3">
												<div className="flex items-center justify-end gap-2">
													<testFetcher.Form method="post">
														<input type="hidden" name="intent" value="test" />
														<input type="hidden" name="id" value={p.id} />
														<Button
															size="icon"
															variant="ghost"
															type="submit"
															title="Test connection"
															aria-label="Test connection"
														>
															<Plug size={15} />
														</Button>
													</testFetcher.Form>
													<Toggle
														checked={Boolean(p.is_active)}
														label={`${p.is_active ? "Deactivate" : "Activate"} proxy ${p.name}`}
														onChange={() => {
															const form = document.getElementById(
																`toggle-proxy-${p.id}`,
															) as HTMLFormElement | null;
															form?.requestSubmit();
														}}
													/>
													<Form
														className="hidden"
														id={`toggle-proxy-${p.id}`}
														method="post"
													>
														<input type="hidden" name="intent" value="toggle" />
														<input type="hidden" name="id" value={p.id} />
													</Form>
													<Form
														method="post"
														onSubmit={async (e) => {
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
														}}
													>
														<input type="hidden" name="intent" value="delete" />
														<input type="hidden" name="id" value={p.id} />
														<Button
															size="icon"
															variant="ghost"
															type="submit"
															title="Delete proxy"
															aria-label="Delete proxy"
															className="text-danger"
														>
															<Trash2 size={15} />
														</Button>
													</Form>
												</div>
												{test && (
													<div
														className={`mt-1 text-right text-xs ${
															test.ok ? "text-success" : "text-danger"
														}`}
													>
														{test.ok ? `OK · ${test.latencyMs}ms` : "failed"}
													</div>
												)}
											</TCell>
										</TRow>
									);
								})}
							</tbody>
						</Table>
					)}
				</Card>
			)}

			{tab === "free" && (
				<div className="space-y-6">
					<Card>
						<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
							<RefreshCw size={15} /> Fetch Free Proxies
						</h2>
						<p className="mb-4 text-xs text-muted-foreground">
							Sync fetches the latest free proxies from public lists. Test
							them, then move the good ones to the proxy list. Syncing
							replaces the previously staged list.
						</p>
						<syncFetcher.Form method="post" className="flex flex-wrap gap-2">
							<input type="hidden" name="intent" value="sync-free" />
							<Select name="source" defaultValue="proxyscrape-http" className="w-auto">
								<option value="auto">Auto (try all sources)</option>
								{FREE_SOURCES.map((s) => (
									<option key={s.id} value={s.id}>
										{s.label}
									</option>
								))}
							</Select>
							<Input
								name="custom_url"
								placeholder="or custom list URL (e.g. your Webshare download link)"
								className="min-w-52 flex-1 font-mono"
							/>
							<Input
								name="limit"
								type="number"
								min={1}
								max={500}
								defaultValue={100}
								title="Max proxies"
								className="w-24"
							/>
							<Button type="submit" disabled={syncRunning}>
								<RefreshCw size={15} /> Sync
								{syncRunning && <Spinner size={14} />}
							</Button>
						</syncFetcher.Form>
					</Card>

					<Card>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
							<h2 className="text-sm font-semibold text-foreground">
								Staged Free Proxies
								<span className="ml-2 text-xs font-normal text-muted-foreground">
									{staging.length} fetched · {selected.size} selected
								</span>
							</h2>
							{showLoadButton && (
								<Button
									size="sm"
									variant="secondary"
									onClick={() => {
										setStaging(syncResults);
										setSelected(new Set());
									}}
								>
									Load {syncResults.length} fetched
								</Button>
							)}
							{staging.length > 0 && (
								<div className="flex flex-wrap items-center gap-2">
									<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
										<Checkbox
											checked={staging.length > 0 && selected.size === staging.length}
											onChange={(e) =>
												setSelected(
													e.target.checked
														? new Set(staging.map((r) => rowKey(r)))
														: new Set<string>(),
												)
											}
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
										<Button
											size="sm"
											variant="outline"
											type="submit"
											disabled={selectedRows.length === 0}
										>
											Test selected
										</Button>
									</batchFetcher.Form>
									<batchFetcher.Form method="post">
										<input type="hidden" name="intent" value="move-free" />
										<input
											type="hidden"
											name="rows"
											value={JSON.stringify(selectedRows)}
										/>
										<Button
											size="sm"
											type="submit"
											disabled={selectedRows.length === 0}
											className="gap-1.5"
										>
											<Plus size={13} /> Move Proxy List
										</Button>
									</batchFetcher.Form>
									<Button
										size="sm"
										variant="outline"
										className="gap-1.5 text-danger"
										disabled={selected.size === 0}
										onClick={() => {
											setStaging((prev) =>
												prev.filter((r) => !selected.has(rowKey(r))),
											);
											setSelected(new Set());
										}}
									>
										<Trash2 size={13} /> Delete selected
									</Button>
								</div>
							)}
						</div>

						{staging.length === 0 && syncResults && (
							<div className="mb-3 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
								{syncResults.length > 0
									? `${syncResults.length} free proxies fetched — click "Load" to review them.`
									: "No proxies found from this source. Try another source or a custom URL."}
							</div>
						)}

						{staging.length === 0 && !syncResults && (
							<p className="text-xs text-muted-foreground">
								Nothing staged yet — hit Sync above to fetch the latest free
								proxies.
							</p>
						)}

						{staging.length > 0 && (
							<div className="max-h-80 overflow-y-auto rounded-lg border border-border">
								<Table>
									<THead className="sticky top-0 bg-surface">
										<TRow>
											<THeadCell className="w-8 px-2" />
											<THeadCell className="px-2">Address</THeadCell>
											<THeadCell className="px-2">Type</THeadCell>
											<THeadCell className="px-2">Test</THeadCell>
										</TRow>
									</THead>
									<tbody>
										{staging.map((r) => {
											const key = rowKey(r);
											const test = freeTests.get(key);
											const status = test ? (test.ok ? "ok" : "fail") : r.status;
											return (
												<TRow key={key}>
													<TCell className="px-2 py-1.5">
														<Checkbox
															checked={selected.has(key)}
															onChange={(e) => markSelected(key, e.target.checked)}
														/>
													</TCell>
													<TCell className="px-2 py-1.5 font-mono text-xs text-muted-foreground">
														{r.host}:{r.port}
													</TCell>
													<TCell className="px-2 py-1.5 text-xs text-muted-foreground">
														{r.type}
													</TCell>
													<TCell className="px-2 py-1.5">
														{status === "ok" && (
															<span className="text-xs font-medium text-success">
																{test?.latencyMs ?? r.latencyMs}ms
															</span>
														)}
														{status === "fail" && (
															<span className="text-xs text-danger">failed</span>
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
																<Button
																	type="submit"
																	size="sm"
																	variant="ghost"
																	className="text-xs text-primary"
																>
																	test
																</Button>
															</batchFetcher.Form>
														)}
													</TCell>
												</TRow>
											);
										})}
									</tbody>
								</Table>
							</div>
						)}

						{batchFetcher.data?.moveResult && (
							<div className="mt-3 rounded-lg bg-muted p-3 text-xs text-foreground">
								<span className="font-semibold text-success">
									{batchFetcher.data.moveResult.moved.length} moved to proxy list
								</span>
								{batchFetcher.data.moveResult.failed.length > 0 && (
									<span className="ml-2 text-danger">
										{batchFetcher.data.moveResult.failed.length} failed
									</span>
								)}
							</div>
						)}
					</Card>

					<Card>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
							<h2 className="text-sm font-semibold text-foreground">Test Tool</h2>
							<p className="text-xs text-muted-foreground">
								Test any proxy before adding or saving it.
							</p>
						</div>
						<customTestFetcher.Form
							method="post"
							className="grid grid-cols-2 gap-2 sm:grid-cols-6"
						>
							<input type="hidden" name="intent" value="test-custom" />
							<Select name="type" defaultValue="http-connect" className="px-2">
								<option value="http-connect">CONNECT</option>
								<option value="socks5">SOCKS5</option>
							</Select>
							<Input
								name="host"
								required
								placeholder="host"
								className="font-mono sm:col-span-2"
							/>
							<Input
								name="port"
								type="number"
								required
								min={1}
								max={65535}
								placeholder="port"
							/>
							<Input
								name="username"
								placeholder="user (opt)"
								autoComplete="off"
							/>
							<Button type="submit">Test</Button>
						</customTestFetcher.Form>
						{customTestFetcher.data?.customTest && (
							<div
								className={`mt-3 rounded-lg px-3 py-2 text-sm ${
									customTestFetcher.data.customTest.ok
										? "bg-success/15 text-success"
										: "bg-danger/15 text-danger"
								}`}
							>
								{customTestFetcher.data.customTest.ok
									? `OK · ${customTestFetcher.data.customTest.latencyMs}ms`
									: `Failed (${
											customTestFetcher.data.customTest.status ?? "no response"
										})`}
							</div>
						)}
					</Card>

					<Card>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
							<h2 className="text-sm font-semibold text-foreground">
								Saved Free Proxies (no auth)
								<span className="ml-2 text-xs font-normal text-muted-foreground">
									{freeSaved.length} saved
								</span>
							</h2>
							{savedSelected.size > 0 && (
								<Form
									method="post"
									onSubmit={async (e) => {
										if (
											!(await confirm({
												title: "Delete selected proxies?",
												description: `${savedSelected.size} selected free proxies will be permanently removed.`,
												confirmLabel: "Delete",
												variant: "danger",
											}))
										) {
											e.preventDefault();
										}
									}}
								>
									{[...savedSelected].map((id) => (
										<input key={id} type="hidden" name="ids" value={id} />
									))}
									<input type="hidden" name="intent" value="delete-many" />
									<Button
										type="submit"
										size="sm"
										variant="outline"
										className="gap-1.5 text-danger"
									>
										<Trash2 size={13} /> Delete selected ({savedSelected.size})
									</Button>
								</Form>
							)}
						</div>

						{freeSaved.length === 0 && (
							<p className="text-xs text-muted-foreground">
								No auth-free proxies saved yet — sync and move some above.
							</p>
						)}

						{freeSaved.length > 0 && (
							<div className="max-h-72 overflow-y-auto rounded-lg border border-border">
								<Table>
									<THead className="sticky top-0 bg-surface">
										<TRow>
											<THeadCell className="w-8 px-2" />
											<THeadCell className="px-2">Name</THeadCell>
											<THeadCell className="px-2">Type</THeadCell>
											<THeadCell className="px-2">Address</THeadCell>
											<THeadCell className="px-2">Status</THeadCell>
											<THeadCell className="px-2 text-right">Actions</THeadCell>
										</TRow>
									</THead>
									<tbody>
										{freeSaved.map((p) => (
											<TRow key={p.id}>
												<TCell className="px-2 py-1.5">
													<Checkbox
														checked={savedSelected.has(p.id)}
														onChange={(e) => {
															setSavedSelected((prev) => {
																const next = new Set(prev);
																if (e.target.checked) next.add(p.id);
																else next.delete(p.id);
																return next;
															});
														}}
													/>
												</TCell>
												<TCell className="px-2 py-1.5 text-foreground">
													{p.name}
												</TCell>
												<TCell className="px-2 py-1.5 text-xs text-muted-foreground">
													{p.type}
												</TCell>
												<TCell className="px-2 py-1.5 font-mono text-xs text-muted-foreground">
													{p.host}:{p.port}
												</TCell>
												<TCell className="px-2 py-1.5">
													<Badge
														tone={p.is_active ? "success" : "danger"}
														style="subtle"
													>
														{p.is_active ? "Active" : "Inactive"}
													</Badge>
												</TCell>
												<TCell className="px-2 py-1.5 text-right">
													<testFetcher.Form method="post">
														<input type="hidden" name="intent" value="test" />
														<input type="hidden" name="id" value={p.id} />
														<Button
															size="icon"
															variant="ghost"
															type="submit"
															title="Test connection"
															aria-label="Test connection"
														>
															<Plug size={15} />
														</Button>
													</testFetcher.Form>
												</TCell>
											</TRow>
										))}
									</tbody>
								</Table>
							</div>
						)}
					</Card>
				</div>
			)}

			{tab === "import" && (
				<Card>
					<h2 className="mb-1 text-sm font-semibold text-foreground">Import</h2>
					<p className="mb-4 text-xs text-muted-foreground">
						One per line:{" "}
						<code className="font-mono">[type://][user:pass@]host:port</code>{" "}
						or a JSON array of objects. Optionally include{" "}
						<code className="font-mono">poolName</code> to group imported
						proxies into a pool. Free proxies (no auth) can be pasted as plain{" "}
						<code className="font-mono">host:port</code> lines.
					</p>
					<importFetcher.Form method="post" className="space-y-3">
						<input type="hidden" name="intent" value="import" />
						<Textarea
							name="text"
							rows={10}
							placeholder={
								"socks5://user:pass@127.0.0.1:1080\nhttp-connect://127.0.0.1:3128\nproxy.example.com:8080"
							}
							className="font-mono"
						/>
						<Button type="submit">
							<Download size={15} /> Import
						</Button>
					</importFetcher.Form>
					{importFetcher.data?.importResult && (
						<div className="mt-4 rounded-lg bg-muted p-3 text-xs text-foreground">
							<span className="font-semibold text-success">
								{importFetcher.data.importResult.imported} imported
							</span>
							{importFetcher.data.importResult.errors.length > 0 && (
								<ul className="mt-1 list-disc pl-4 text-danger">
									{importFetcher.data.importResult.errors.map((e, i) => (
										<li key={i}>{e}</li>
									))}
								</ul>
							)}
						</div>
					)}
				</Card>
			)}

			{tab === "pools" && (
				<div className="space-y-6">
					<Card>
						<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
							<Globe size={15} /> Global Proxy
						</h2>
						<p className="mb-4 text-xs text-muted-foreground">
							Default fallback pool when neither a client API key nor a
							provider pool is assigned. Priority: client key → provider →
							global → direct.
						</p>
						<Form method="post" className="flex gap-2">
							<input type="hidden" name="intent" value="set-global" />
							<Select
								name="pool_id"
								defaultValue={loaderData.globalPoolId ?? ""}
								className="flex-1"
							>
								<option value="">— None (direct) —</option>
								{loaderData.pools.map((pool) => (
									<option key={pool.id} value={pool.id}>
										{pool.name}
									</option>
								))}
							</Select>
							<Button type="submit">Save</Button>
						</Form>
						{globalPool && (
							<p className="mt-3 text-xs text-success">
								Currently using pool{" "}
								<span className="font-semibold">{globalPool.name}</span> (
								{globalPool.proxy_ids.length} proxies)
							</p>
						)}
					</Card>

					<Card>
						<h2 className="mb-4 text-sm font-semibold text-foreground">Pools</h2>
						{loaderData.pools.length === 0 && (
							<p className="text-xs text-muted-foreground">
								No pools yet. Create one below.
							</p>
						)}
						<div className="space-y-4">
							{loaderData.pools.map((pool) => (
								<div key={pool.id} className="rounded-lg border border-border p-4">
									<div className="mb-3 flex items-center justify-between">
										<h3 className="text-sm font-semibold text-foreground">
											{pool.name}
											<span className="ml-2 text-xs font-normal text-muted-foreground">
												{pool.proxy_ids.length} proxies ·{" "}
												{pool.is_active ? "active" : "inactive"}
											</span>
										</h3>
										<Form
											method="post"
											onSubmit={async (e) => {
												if (
													!(await confirm({
														title: "Delete pool?",
														description: `Pool "${pool.name}" and its proxy assignments will be deleted.`,
														confirmLabel: "Delete",
														variant: "danger",
													}))
												) {
													e.preventDefault();
												}
											}}
										>
											<input type="hidden" name="intent" value="delete-pool" />
											<input type="hidden" name="id" value={pool.id} />
											<Button
												size="icon"
												variant="ghost"
												type="submit"
												title="Delete pool"
												aria-label="Delete pool"
												className="text-danger"
											>
												<Trash2 size={15} />
											</Button>
										</Form>
									</div>
									<Form method="post">
										<input type="hidden" name="intent" value="update-pool" />
										<input type="hidden" name="id" value={pool.id} />
										<div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-border p-2">
											{loaderData.proxies.map((p) => (
												<label
													key={p.id}
													className="flex items-center gap-2 rounded px-2 py-1 text-sm text-foreground hover:bg-muted"
												>
													<Checkbox
														name="proxy_ids"
														value={p.id}
														defaultChecked={pool.proxy_ids.includes(p.id)}
														disabled={!p.is_active}
													/>
													{p.name}{" "}
													<span className="font-mono text-xs text-muted-foreground">
														({p.type} {p.host}:{p.port}
														{!p.is_active ? " inactive" : ""})
													</span>
												</label>
											))}
											{loaderData.proxies.length === 0 && (
												<p className="p-2 text-xs text-muted-foreground">
													No proxies defined.
												</p>
											)}
										</div>
										<Button
											type="submit"
											size="sm"
											variant="secondary"
											className="mt-3"
										>
											Save pool
										</Button>
									</Form>
								</div>
							))}
						</div>
						<Form method="post" className="mt-4 flex gap-2">
							<input type="hidden" name="intent" value="create-pool" />
							<Input name="name" placeholder="Pool name" />
							<Button type="submit">Create pool</Button>
						</Form>
					</Card>

					<Card>
						<h2 className="mb-1 text-sm font-semibold text-foreground">
							Assignments
						</h2>
						<p className="mb-4 text-xs text-muted-foreground">
							Priority: client key → provider → global → direct.
						</p>
						{loaderData.assignments.length === 0 && (
							<p className="text-xs text-muted-foreground">
								Nothing assigned yet.
							</p>
						)}
						{loaderData.assignments.length > 0 && (
							<Table>
								<THead>
									<TRow>
										<THeadCell className="px-2">Target</THeadCell>
										<THeadCell className="px-2">Kind</THeadCell>
										<THeadCell className="px-2">Pool</THeadCell>
										<THeadCell className="px-2 text-right">Actions</THeadCell>
									</TRow>
								</THead>
								<tbody>
									{loaderData.assignments.map((a, i) => {
										const pool = loaderData.pools.find(
											(p) => p.id === a.proxy_pool_id,
										);
										const targetName =
											a.target_type === "provider"
												? loaderData.providers.find(
														(p) => p.id === a.target_id,
													)?.name
												: loaderData.apiKeys.find(
														(k) => String(k.id) === a.target_id,
													)?.name;
										return (
											<TRow key={i}>
												<TCell className="px-2 py-2 text-foreground">
													{targetName ?? a.target_id}
												</TCell>
												<TCell className="px-2 py-2 text-xs text-muted-foreground">
													{a.target_type}
												</TCell>
												<TCell className="px-2 py-2 text-foreground">
													{pool?.name ?? a.proxy_pool_id}
												</TCell>
												<TCell className="px-2 py-2 text-right">
													<Form
														method="post"
														onSubmit={async (e) => {
															if (
																!(await confirm({
																	title: "Remove assignment?",
																	description: "This pool assignment will be removed.",
																	confirmLabel: "Remove",
																	variant: "danger",
																}))
															) {
																e.preventDefault();
															}
														}}
													>
														<input type="hidden" name="intent" value="unassign" />
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
														<Button
															type="submit"
															size="sm"
															variant="ghost"
															className="text-xs text-danger"
														>
															remove
														</Button>
													</Form>
												</TCell>
											</TRow>
										);
									})}
								</tbody>
							</Table>
						)}
						<Form
							method="post"
							className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-4"
						>
							<input type="hidden" name="intent" value="assign" />
							<Select name="target_type" defaultValue="provider">
								<option value="provider">Provider</option>
								<option value="client_key">API Key</option>
							</Select>
							<Select name="target_id">
								{loaderData.providers.map((p) => (
									<option key={p.id} value={p.id}>
										{p.name}
									</option>
								))}
							</Select>
							<Select name="pool_id">
								{loaderData.pools.map((pool) => (
									<option key={pool.id} value={pool.id}>
										{pool.name}
									</option>
								))}
							</Select>
							<Button type="submit">Assign</Button>
						</Form>
					</Card>
				</div>
			)}

			{dialog}
		</div>
	);
}
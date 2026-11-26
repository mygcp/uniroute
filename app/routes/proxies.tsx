import { Form, Link, redirect, useFetcher, useNavigation, useOutlet, useSearchParams, useSubmit } from "react-router";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { Route } from "./+types/proxies";
import { requireLoaderSession, requireSession } from "../.server/auth";
import { createLimiter } from "../.server/async-utils";
import { exec, query } from "../.server/db";
import { assertSafeUrl } from "../.server/ssrf";
import { fmtTs } from "../lib/log-format";
import {
	listProxies,
	listPools,
	listAssignments,
	getProxy,
	updateProxy,
	deleteProxy,
	deleteProxiesBatch,
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
import { Plus, Trash2, Plug, Download, Globe, RefreshCw, Layers, Link2, FlaskConical, List, Database } from "lucide-react";
import { Button, buttonClass } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Checkbox, Input, Label, Select, Textarea } from "../components/ui/field";
import { Tabs } from "../components/ui/tabs";
import { Toggle } from "../components/ui/toggle";
import { PageHeader } from "../components/ui/page-header";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/feedback";
import { Table, THead, THeadCell, TRow, TCell } from "../components/ui/table";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function meta() {
	return [{ title: "Proxies | UniRoute" }];
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
	try {
		await assertSafeUrl(sourceUrl, { allowPrivate: false, allowLoopback: false });
	} catch {
		return [];
	}
	try {
		const resp = await fetch(sourceUrl, {
			redirect: "manual",
			signal: AbortSignal.timeout(10_000),
		});
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
	}
}

//---------------------------------------------------------------------------
// Loader / action
//---------------------------------------------------------------------------

export async function loader({ request }: Route.LoaderArgs) {
	requireLoaderSession(request);
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
	const proxies = listProxies().map(({ password, password_enc, ...rest }) => ({
		...rest,
		has_password: Boolean(password || password_enc),
	}));
	return {
		proxies,
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
	const limit = createLimiter(8);
	await Promise.all(
		rows.map((row) =>
			limit(async () => {
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
		),
	);
}

export async function action({ request }: Route.ActionArgs) {
	const denied = requireSession(request);
	if (denied) return denied;
	const form = await request.formData();
	const intent = String(form.get("intent"));
	const tabParam = new URL(request.url).searchParams.get("tab");

	if (intent === "toggle") {
		const id = Number(form.get("id"));
		const current = getProxy(id);
		if (current) updateProxy(id, { is_active: !current.is_active });
		return redirect("/proxies");
	}

	if (intent === "delete") {
		deleteProxy(Number(form.get("id")));
		return redirect(tabParam ? `/proxies?tab=${encodeURIComponent(tabParam)}` : "/proxies");
	}

	if (intent === "delete-many") {
		deleteProxiesBatch(form.getAll("ids").map(Number));
		return redirect(tabParam ? `/proxies?tab=${encodeURIComponent(tabParam)}` : "/proxies");
	}

	if (intent === "delete-errors") {
		const rows = query(
			"SELECT id FROM outbound_proxies WHERE last_error IS NOT NULL",
		).all() as unknown as { id: number }[];
		deleteProxiesBatch(rows.map((r) => Number(r.id)));
		return redirect("/proxies");
	}

	if (intent === "bulk-active") {
		const active = form.get("active") === "1";
		exec("BEGIN");
		try {
			for (const id of form.getAll("ids").map(Number)) {
				const current = getProxy(id);
				if (current && current.is_active !== active) {
					updateProxy(id, { is_active: active });
				}
			}
			exec("COMMIT");
		} catch (err) {
			exec("ROLLBACK");
			throw err;
		}
		return redirect("/proxies");
	}

	if (intent === "test-many") {
		const ids = [...new Set(form.getAll("ids").map(Number))].filter((n) =>
			Number.isFinite(n),
		);
		const customUrl = String(form.get("url") || "").trim();
		const results: Array<{ id: number; ok: boolean; latencyMs: number }> = [];
		const limit = createLimiter(8);
		await Promise.all(
			ids.map((id) =>
				limit(async () => {
					const proxy = getProxy(id);
					if (!proxy) return;
					const r = await testProxyConnection(
						proxy,
						customUrl || undefined,
					);
					results.push({ id, ok: r.ok, latencyMs: r.latencyMs });
				}),
			),
		);
		return { manyTests: results };
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
			for (let i = 0; i < FREE_SOURCES.length && rows.length === 0; i += 3) {
				const batch = FREE_SOURCES.slice(i, i + 3);
				const fetched = await Promise.all(
					batch.map((s) => {
						const t: ProxyType = s.id.includes("socks5") ? "socks5" : "http-connect";
						return fetchFreeProxies(s.url, t, limit, s.format);
					}),
				);
				for (const chunk of fetched) {
					if (chunk.length > 0) {
						rows = chunk;
						break;
					}
				}
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
		createPool({
			name: String(form.get("name") || "").trim(),
			proxy_ids: [],
			strategy: String(form.get("strategy")) as
				| "round_robin"
				| "priority"
				| "random",
		});
		return redirect("/proxies?tab=pools");
	}

	if (intent === "update-pool") {
		updatePool(Number(form.get("id")), {
			proxy_ids: form.getAll("proxy_ids").map(Number),
			strategy: String(form.get("strategy")) as
				| "round_robin"
				| "priority"
				| "random",
		});
		return redirect("/proxies?tab=pools");
	}

	if (intent === "delete-pool") {
		deletePool(Number(form.get("id")));
		return redirect("/proxies?tab=pools");
	}

	if (intent === "set-global") {
		const raw = String(form.get("pool_id") || "");
		setGlobalProxyPool(raw ? Number(raw) : null);
		return redirect("/proxies?tab=pools");
	}

	if (intent === "assign") {
		const targetType =
			String(form.get("target_type")) === "provider" ? "provider" : "client_key";
		const targetId = String(form.get("target_id"));
		unassignPool(targetType, targetId);
		assignPool({
			proxyPoolId: Number(form.get("pool_id")),
			targetType,
			targetId,
		});
		return redirect("/proxies?tab=pools");
	}

	if (intent === "unassign") {
		unassignPool(
			String(form.get("target_type")) === "provider" ? "provider" : "client_key",
			String(form.get("target_id")),
		);
		return redirect("/proxies?tab=pools");
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
// Memoized sub-components
//
// Local state (checkbox selections, tab switches, fetcher results) no longer
// re-renders the entire page — only the affected rows re-render.
//---------------------------------------------------------------------------

type ProxyRow = Route.ComponentProps["loaderData"]["proxies"][number];

type Health = "ok" | "error" | "unknown";

function healthOf(p: ProxyRow): Health {
	if (p.last_error) return "error";
	if (p.last_ok_at) return "ok";
	return "unknown";
}

type ConfirmFn = (opts: {
	title: string;
	description?: string;
	confirmLabel?: string;
	cancelLabel?: string;
	variant?: "primary" | "danger";
}) => Promise<boolean>;

const ProxyListRow = memo(function ProxyListRow({
	proxy,
	selected,
	onToggle,
	batchResult,
	confirm,
}: {
	proxy: ProxyRow;
	selected: boolean;
	onToggle: (id: number, checked: boolean) => void;
	batchResult: { ok: boolean; latencyMs: number } | undefined;
	confirm: ConfirmFn;
}) {
	// Fetcher per-baris: klik test di satu baris tidak akan mengganggu
	// baris lain atau hasil batch (test all) sebelumnya.
	const rowFetcher = useFetcher<{
		test: { id: number; ok: boolean; latencyMs: number };
	}>();
	const testing = rowFetcher.state !== "idle";
	const single = rowFetcher.data?.test;
	const submit = useSubmit();
	const result =
		single && single.id === proxy.id
			? { ok: single.ok, latencyMs: single.latencyMs }
			: (batchResult ?? null);
	const health = healthOf(proxy);
	return (
		<TRow key={proxy.id}>
			<TCell className="w-8 px-3 py-2.5">
				<Checkbox
					checked={selected}
					onChange={(e) => onToggle(proxy.id, e.target.checked)}
					aria-label={`Select proxy ${proxy.name}`}
				/>
			</TCell>
			<TCell className="max-w-[140px] truncate px-2.5 py-2.5 font-medium text-foreground">
				<Link to={`/proxies/${proxy.id}`} prefetch="intent" className="hover:text-primary" title={proxy.name}>
					{proxy.name}
				</Link>
			</TCell>
			<TCell className="whitespace-nowrap px-2.5 py-2.5">
				<Badge tone="neutral" style="subtle">
					{proxy.type}
				</Badge>
			</TCell>
			<TCell className="whitespace-nowrap px-2.5 py-2.5 font-mono text-xs text-muted-foreground">
				{proxy.host}:{proxy.port}
			</TCell>
			<TCell className="max-w-[90px] truncate px-2.5 py-2.5 text-muted-foreground">
				{proxy.username ? proxy.username : "-"}
			</TCell>
			<TCell className="whitespace-nowrap px-2.5 py-2.5 text-xs text-muted-foreground">
				{proxy.last_used_at ? fmtTs(proxy.last_used_at) : "Never"}
			</TCell>
			<TCell className="whitespace-nowrap px-2.5 py-2.5">
				<Badge
					tone={proxy.is_active ? "success" : "danger"}
					style="subtle"
				>
					{proxy.is_active ? "Active" : "Inactive"}
				</Badge>
			</TCell>
			<TCell className="whitespace-nowrap px-2.5 py-2.5">
				<span
					title={
						health === "error"
							? `Last error: ${proxy.last_error}`
							: `Success/fail: ${proxy.success_count}/${proxy.fail_count}`
					}
				>
					<Badge
						tone={
							health === "ok"
								? "success"
								: health === "error"
									? "danger"
									: "neutral"
						}
						style="subtle"
					>
						{health === "ok"
							? `Healthy${proxy.last_latency_ms != null ? ` · ${proxy.last_latency_ms}ms` : ""}`
							: health === "error"
								? "Error"
								: "Untested"}
					</Badge>
				</span>
			</TCell>
			<TCell className="whitespace-nowrap px-3 py-2.5">
				<div className="flex items-center justify-end gap-2">
					<Button
						size="icon"
						variant="outline"
						type="button"
						title="Test connection"
						aria-label="Test connection"
						disabled={testing}
						onClick={() =>
							rowFetcher.submit(
								{ intent: "test", id: String(proxy.id) },
								{ method: "POST" },
							)
						}
					>
						{testing ? <Spinner size={14} /> : <Plug size={14} />}
					</Button>
					<Toggle
						checked={Boolean(proxy.is_active)}
						label={`${proxy.is_active ? "Deactivate" : "Activate"} proxy ${proxy.name}`}
						onChange={() => {
							const form = document.getElementById(
								`toggle-proxy-${proxy.id}`,
							) as HTMLFormElement | null;
							form?.requestSubmit();
						}}
					/>
					<Form
						className="hidden"
						id={`toggle-proxy-${proxy.id}`}
						method="post"
					>
						<input type="hidden" name="intent" value="toggle" />
						<input type="hidden" name="id" value={proxy.id} />
					</Form>
					<Form
						method="post"
						onSubmit={(e) => {
							e.preventDefault();
							const form = e.currentTarget;
							void confirm({
								title: "Delete proxy?",
								description: `Proxy "${proxy.name}" will be permanently removed.`,
								confirmLabel: "Delete",
								variant: "danger",
							}).then((ok) => {
								if (ok) submit(form);
							});
						}}
					>
						<input type="hidden" name="intent" value="delete" />
						<input type="hidden" name="id" value={proxy.id} />
						<Button
							size="icon"
							variant="danger"
							type="submit"
							title="Delete proxy"
							aria-label="Delete proxy"
						>
							<Trash2 size={14} />
						</Button>
					</Form>
				</div>
				{result && (
					<div
						className={`mt-1 text-right text-xs ${
							result.ok ? "text-success" : "text-danger"
						}`}
					>
						{result.ok ? `OK · ${result.latencyMs}ms` : "failed"}
					</div>
				)}
			</TCell>
		</TRow>
	);
});

const StagingProxyRow = memo(function StagingProxyRow({
	row,
	selected,
	test,
	onToggle,
	onTest,
}: {
	row: FreeProxyRow;
	selected: boolean;
	test: { key: string; ok: boolean; latencyMs: number } | undefined;
	onToggle: (key: string, checked: boolean) => void;
	onTest: (row: FreeProxyRow) => void;
}) {
	const key = rowKey(row);
	const status = test ? (test.ok ? "ok" : "fail") : row.status;
	return (
		<TRow key={key}>
			<TCell className="px-2 py-1.5">
				<Checkbox
					checked={selected}
					onChange={(e) => onToggle(key, e.target.checked)}
				/>
			</TCell>
			<TCell className="px-2 py-1.5 font-mono text-xs text-muted-foreground">
				{row.host}:{row.port}
			</TCell>
			<TCell className="px-2 py-1.5 text-xs text-muted-foreground">
				{row.type}
			</TCell>
			<TCell className="px-2 py-1.5">
				{status === "ok" && (
					<span className="text-xs font-medium text-success">
						{test?.latencyMs ?? row.latencyMs}ms
					</span>
				)}
				{status === "fail" && (
					<span className="text-xs text-danger">failed</span>
				)}
				{!status && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="text-xs text-primary"
						onClick={() => onTest(row)}
					>
						Test
					</Button>
				)}
			</TCell>
		</TRow>
	);
});

const SavedProxyRow = memo(function SavedProxyRow({
	proxy,
	selected,
	onToggle,
}: {
	proxy: ProxyRow;
	selected: boolean;
	onToggle: (id: number, checked: boolean) => void;
}) {
	// Fetcher per-baris agar klik test tidak saling membatalkan antar baris.
	const rowFetcher = useFetcher<{
		test: { id: number; ok: boolean; latencyMs: number };
	}>();
	const testing = rowFetcher.state !== "idle";
	const result = rowFetcher.data?.test;
	return (
		<TRow key={proxy.id}>
			<TCell className="px-2 py-1.5">
				<Checkbox
					checked={selected}
					onChange={(e) => onToggle(proxy.id, e.target.checked)}
				/>
			</TCell>
			<TCell className="px-2 py-1.5 text-foreground">
				{proxy.name}
			</TCell>
			<TCell className="px-2 py-1.5 text-xs text-muted-foreground">
				{proxy.type}
			</TCell>
			<TCell className="px-2 py-1.5 font-mono text-xs text-muted-foreground">
				{proxy.host}:{proxy.port}
			</TCell>
			<TCell className="px-2 py-1.5">
				<Badge
					tone={proxy.is_active ? "success" : "danger"}
					style="subtle"
				>
					{proxy.is_active ? "Active" : "Inactive"}
				</Badge>
			</TCell>
			<TCell className="px-2 py-1.5 text-right">
				<Button
					size="icon"
					variant="outline"
					type="button"
					title="Test connection"
					aria-label="Test connection"
					disabled={testing}
					onClick={() =>
						rowFetcher.submit(
							{ intent: "test", id: String(proxy.id) },
							{ method: "POST" },
						)
					}
				>
					{testing ? <Spinner size={14} /> : <Plug size={14} />}
				</Button>
				{result && result.id === proxy.id && (
					<div
						className={`mt-1 text-right text-xs ${
							result.ok ? "text-success" : "text-danger"
						}`}
					>
						{result.ok ? `OK · ${result.latencyMs}ms` : "failed"}
					</div>
				)}
			</TCell>
		</TRow>
	);
});

function BulkActiveForm({
	ids,
	active,
	label,
}: {
	ids: Set<number>;
	active: "1" | "0";
	label: string;
}) {
	return (
		<Form method="post">
			<input type="hidden" name="intent" value="bulk-active" />
			<input type="hidden" name="active" value={active} />
			{[...ids].map((id) => (
				<input key={id} type="hidden" name="ids" value={id} />
			))}
			<Button size="sm" variant={active === "1" ? "secondary" : "outline"} type="submit">
				{label}
			</Button>
		</Form>
	);
}

function BulkDeleteForm({
	ids,
	confirm,
}: {
	ids: Set<number>;
	confirm: ConfirmFn;
}) {
	const submit = useSubmit();
	return (
		<Form
			method="post"
			onSubmit={(e) => {
				e.preventDefault();
				const form = e.currentTarget;
				void confirm({
					title: "Delete selected proxies?",
					description: `${ids.size} selected proxies will be permanently removed.`,
					confirmLabel: "Delete",
					variant: "danger",
				}).then((ok) => {
					if (ok) submit(form);
				});
			}}
		>
			<input type="hidden" name="intent" value="delete-many" />
			{[...ids].map((id) => (
				<input key={id} type="hidden" name="ids" value={id} />
			))}
			<Button
				size="sm"
				variant="danger"
				type="submit"
				className="gap-1.5"
			>
				<Trash2 size={14} /> Delete
			</Button>
		</Form>
	);
}

//---------------------------------------------------------------------------
// Component
//---------------------------------------------------------------------------

type TabKey = "list" | "free" | "import" | "pools";
const VALID_TABS = new Set<TabKey>(["list", "free", "import", "pools"]);

export default function Proxies(props: Route.ComponentProps) {
	const outlet = useOutlet();
	if (outlet) return outlet;
	return <ProxiesView loaderData={props.loaderData} />;
}

function ProxiesView({ loaderData }: { loaderData: Route.ComponentProps["loaderData"] }) {
	const [searchParams, setSearchParams] = useSearchParams();
	const rawTab = searchParams.get("tab") as TabKey | null;
	const tab: TabKey = rawTab && VALID_TABS.has(rawTab) ? rawTab : "list";
	const setTab = useCallback(
		(next: TabKey) => {
			setSearchParams(
				(prev) => {
					const copy = new URLSearchParams(prev);
					if (next === "list") copy.delete("tab");
					else copy.set("tab", next);
					return copy;
				},
				{ replace: true },
			);
		},
		[setSearchParams],
	);
	const submit = useSubmit();
	const [assignTargetType, setAssignTargetType] = useState<"provider" | "client_key">("provider");
	const [staging, setStaging] = useState<FreeProxyRow[]>([]);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [savedSelected, setSavedSelected] = useState<Set<number>>(new Set());
	const [loadedSig, setLoadedSig] = useState<string | null>(null);

	// Advanced list management state
	const [listSel, setListSel] = useState<Set<number>>(new Set());
	const [listSearch, setListSearch] = useState("");
	const [listFilter, setListFilter] = useState<
		"all" | "active" | "inactive" | "ok" | "error"
	>("all");

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
	const manyTestFetcher = useFetcher<{
		manyTests?: Array<{ id: number; ok: boolean; latencyMs: number }>;
		error?: string;
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
	const syncSig = syncResults?.map((r) => rowKey(r)).join("\n") ?? null;
	useEffect(() => {
		if (syncResults && syncSig !== loadedSig) {
			setStaging(syncResults);
			setSelected(new Set());
			setLoadedSig(syncSig);
		}
	}, [syncResults, syncSig, loadedSig]);
	const freeTests = new Map(
		(batchFetcher.data?.freeTests ?? []).map((t) => [t.key, t]),
	);

	const markSelected = useCallback((key: string, value: boolean) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (value) next.add(key);
			else next.delete(key);
			return next;
		});
	}, []);

	const markSavedSelected = useCallback((id: number, checked: boolean) => {
		setSavedSelected((prev) => {
			const next = new Set(prev);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);

	// Route fetcher-driven actions through refs so the callbacks stay stable
	// across renders (keeps the memoized rows from re-rendering).
	const batchFetcherRef = useRef(batchFetcher);
	batchFetcherRef.current = batchFetcher;
	const manyTestFetcherRef = useRef(manyTestFetcher);
	manyTestFetcherRef.current = manyTestFetcher;

	const testStagedRow = useCallback((row: FreeProxyRow) => {
		batchFetcherRef.current.submit(
			{ intent: "test-free", rows: JSON.stringify([row]) },
			{ method: "POST" },
		);
	}, []);

	const selectedRows = staging.filter((r) => selected.has(rowKey(r)));

	// --- advanced list management -------------------------------------------
	const manyTests = new Map(
		(manyTestFetcher.data?.manyTests ?? []).map((r) => [r.id, r]),
	);
	const manyRunning = manyTestFetcher.state !== "idle";
	const manySummary = manyTestFetcher.data?.manyTests
		? {
				total: manyTestFetcher.data.manyTests.length,
				ok: manyTestFetcher.data.manyTests.filter((r) => r.ok).length,
			}
		: null;

	const filteredProxies = (() => {
		const q = listSearch.trim().toLowerCase();
		return loaderData.proxies.filter((p) => {
			if (listFilter === "active" && !p.is_active) return false;
			if (listFilter === "inactive" && p.is_active) return false;
			if (listFilter === "ok" && healthOf(p) !== "ok") return false;
			if (listFilter === "error" && healthOf(p) !== "error") return false;
			if (
				q &&
				!`${p.name} ${p.type} ${p.host}:${p.port}`
					.toLowerCase()
					.includes(q)
			)
				return false;
			return true;
		});
	})();
	const shownIds = filteredProxies.map((p) => p.id);
	const allShownSelected =
		shownIds.length > 0 && shownIds.every((id) => listSel.has(id));
	const errorCount = loaderData.proxies.filter(
		(p) => healthOf(p) === "error",
	).length;

	const markListSel = useCallback((id: number, checked: boolean) => {
		setListSel((prev) => {
			const next = new Set(prev);
			if (checked) next.add(id);
			else next.delete(id);
			return next;
		});
	}, []);

	// Buang seleksi untuk proxy yang sudah tidak ada (setelah delete/bulk).
	useEffect(() => {
		const validIds = new Set(loaderData.proxies.map((p) => p.id));
		setListSel((prev) => {
			if (prev.size === 0) return prev;
			const next = new Set([...prev].filter((id) => validIds.has(id)));
			return next.size === prev.size ? prev : next;
		});
		setSavedSelected((prev) => {
			if (prev.size === 0) return prev;
			const next = new Set([...prev].filter((id) => validIds.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [loaderData.proxies]);

	const submitManyTest = useCallback(
		(ids: number[], url: string) => {
			if (ids.length === 0) return;
			const fd = new FormData();
			fd.set("intent", "test-many");
			fd.set("url", url);
			for (const id of ids) fd.append("ids", String(id));
			manyTestFetcherRef.current.submit(fd, { method: "POST" });
		},
		[],
	);

	const { dialog, confirm } = useConfirm();
	const { toast } = useToast();
	const navigation = useNavigation();

	// Plain <Form> mutations below all end in redirect("/proxies"), so there
	// is no actionData/fetcher payload to observe. Capture the submitted
	// intent + key details while the navigation is in flight, then toast once
	// it settles (a throw renders the error boundary instead, so reaching
	// idle here with a pending intent means success).
	type PendingProxyMutation = {
		intent: string;
		id: string;
		ids: string[];
		name: string | null;
		count: number;
		extra: string;
	};
	const pendingMutationRef = useRef<PendingProxyMutation | null>(null);
	if (navigation.state !== "idle" && navigation.formData) {
		const fd = navigation.formData;
		const intent = String(fd.get("intent") ?? "");
		const id = String(fd.get("id") ?? "");
		const pre = id
			? loaderData.proxies.find((x) => String(x.id) === id)
			: undefined;
		const prePool =
			!pre && id
				? loaderData.pools.find((x) => String(x.id) === id)
				: undefined;
		const idList = fd.getAll("ids").map(String);
		pendingMutationRef.current = {
			intent,
			id,
			ids: idList,
			name:
				pre?.name ??
				prePool?.name ??
				(String(fd.get("name") ?? "").trim() || null),
			count: intent === "delete-errors" ? errorCount : idList.length,
			extra: String(fd.get("active") ?? fd.get("pool_id") ?? ""),
		};
	}

	useEffect(() => {
		if (navigation.state !== "idle") return;
		const pending = pendingMutationRef.current;
		if (!pending) return;
		pendingMutationRef.current = null;
		const poolName = (pid: string) =>
			loaderData.pools.find((x) => String(x.id) === pid)?.name ?? pid;
		let title: string | null = null;
		let description: string | undefined;
		switch (pending.intent) {
			case "toggle": {
				const cur = loaderData.proxies.find(
					(x) => String(x.id) === pending.id,
				);
				title = cur
					? `Proxy "${cur.name}" ${cur.is_active ? "activated" : "deactivated"}`
					: "Proxy updated";
				break;
			}
			case "delete":
				title = `Proxy "${pending.name ?? `#${pending.id}`}" deleted`;
				break;
			case "delete-many":
				title = `${pending.count} ${pending.count === 1 ? "proxy" : "proxies"} deleted`;
				break;
			case "delete-errors":
				title = `${pending.count} error ${pending.count === 1 ? "proxy" : "proxies"} deleted`;
				break;
			case "bulk-active":
				title = `${pending.count} ${pending.count === 1 ? "proxy" : "proxies"} ${pending.extra === "1" ? "activated" : "deactivated"}`;
				break;
			case "create-pool":
				title = `Pool "${pending.name ?? "Untitled"}" created`;
				break;
			case "update-pool":
				title = `Pool "${poolName(pending.id)}" saved`;
				break;
			case "delete-pool":
				title = `Pool "${pending.name ?? `#${pending.id}`}" deleted`;
				break;
			case "set-global":
				title = "Global proxy updated";
				description = pending.extra
					? `Using pool "${poolName(pending.extra)}".`
					: "Using direct connection.";
				break;
			case "assign":
				title = "Assignment saved";
				break;
			case "unassign":
				title = "Assignment removed";
				break;
			default:
				title = null;
		}
		if (title) toast({ title, description, variant: "success" });
	}, [navigation.state, toast, loaderData.proxies, loaderData.pools]);

	const syncRunning = syncFetcher.state === "submitting";
	const showLoadButton =
		syncResults &&
		syncResults.length > 0 &&
		syncSig !== null &&
		loadedSig !== syncSig;

	return (
		<div>
			<PageHeader
				title="Proxy Engine"
				icon={<Globe size={20} />}
				subtitle="HTTP CONNECT & SOCKS5 outbound routing"
				actions={
					<Link
						to="/proxies/create"
						prefetch="render"
						className={buttonClass("primary", "md")}
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
							icon={<Plug size={24} />}
							title="No proxies yet"
							description="Use the Free Proxy tab to fetch some, or the Import tab to paste them."
						/>
					) : (
						<>
							{/* Toolbar: search, health filter, custom test URL */}
							<div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-2/30 px-4 py-3">
								<Input
									controlSize="sm"
									value={listSearch}
									onChange={(e) => setListSearch(e.target.value)}
									placeholder="Search name / host..."
									className="w-full sm:w-48"
								/>
								<Select
									controlSize="sm"
									value={listFilter}
									onChange={(e) =>
										setListFilter(
											e.target.value as typeof listFilter,
										)
									}
									className="w-full sm:w-36"
								>
									<option value="all">All</option>
									<option value="active">Active</option>
									<option value="inactive">Inactive</option>
									<option value="ok">Healthy</option>
									<option value="error">Error</option>
								</Select>
								<span className="text-xs tabular-nums text-muted-foreground">
									{filteredProxies.length} of {loaderData.proxies.length}
								</span>

								{errorCount > 0 && (
									<>
										<Button
											size="sm"
											variant="outline"
											type="button"
											title="Select all proxies whose last test failed"
											onClick={() => {
												const next = new Set(listSel);
												for (const p of loaderData.proxies) {
													if (healthOf(p) === "error") next.add(p.id);
												}
												setListSel(next);
											}}
										>
											Select errors ({errorCount})
										</Button>
										<Form
											method="post"
											onSubmit={(e) => {
												e.preventDefault();
												const form = e.currentTarget;
												void confirm({
													title: "Delete all error proxies?",
													description: `${errorCount} proxies whose last connection test failed will be permanently removed.`,
													confirmLabel: "Delete",
													variant: "danger",
												}).then((ok) => {
													if (ok) submit(form);
												});
											}}
										>
											<input type="hidden" name="intent" value="delete-errors" />
											<Button
												size="sm"
												variant="danger"
												type="submit"
												className="gap-1.5"
											>
												<Trash2 size={14} /> Delete error ({errorCount})
											</Button>
										</Form>
									</>
								)}

								<div className="ml-auto flex flex-wrap items-center gap-2">
									<Input
										controlSize="sm"
										defaultValue="https://api.openai.com/v1/models"
										id="bulk-test-url"
										placeholder="Test URL"
										className="w-full font-mono sm:w-64"
									/>
									<Button
										size="sm"
										variant="outline"
										type="button"
										disabled={manyRunning}
										onClick={() => {
											const url =
												(
													document.getElementById(
														"bulk-test-url",
													) as HTMLInputElement | null
												)?.value.trim() ?? "";
											submitManyTest(
												loaderData.proxies.map((p) => p.id),
												url,
											);
										}}
									>
										{manyRunning ? <Spinner size={14} /> : <RefreshCw size={14} />}
										{manyRunning ? "Testing…" : "Test all"}
									</Button>
									<Button
										size="sm"
										variant="outline"
										type="button"
										disabled={manyRunning || listSel.size === 0}
										onClick={() => {
											const url =
												(
													document.getElementById(
														"bulk-test-url",
													) as HTMLInputElement | null
												)?.value.trim() ?? "";
											submitManyTest([...listSel], url);
										}}
									>
										<Plug size={14} /> Test selected ({listSel.size})
									</Button>
								</div>
							</div>

							{/* Bulk selection bar */}
							{listSel.size > 0 && (
								<div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-4 py-2">
									<span className="text-xs font-medium text-foreground">
										{listSel.size} selected
									</span>
									<Button
										size="sm"
										variant="ghost"
										type="button"
										className="text-xs"
										onClick={() =>
											setListSel(new Set(shownIds))
										}
									>
										Select shown
									</Button>
									<Button
										size="sm"
										variant="ghost"
										type="button"
										className="text-xs"
										onClick={() => setListSel(new Set())}
									>
										Clear
									</Button>
									<BulkActiveForm ids={listSel} active="1" label="Activate" />
									<BulkActiveForm ids={listSel} active="0" label="Deactivate" />
									<BulkDeleteForm ids={listSel} confirm={confirm} />
								</div>
							)}

							{manySummary && !manyRunning && (
								<div className="border-b border-border bg-surface-2/40 px-4 py-2 text-xs">
									<span className="font-medium text-success">
										{manySummary.ok} OK
									</span>{" "}
									<span className="text-danger">
										{manySummary.total - manySummary.ok} failed
									</span>{" "}
									<span className="text-muted-foreground">
										- health & latency saved to the database.
									</span>
								</div>
							)}
							{manyTestFetcher.data?.error ? (
								<div className="border-b border-border px-4 py-2 text-xs text-danger">
									{String(manyTestFetcher.data.error)}
								</div>
							) : null}

							<div className="max-h-[70vh] overflow-auto">
								<Table className="min-w-[780px]">
									<THead className="sticky top-0 z-10 bg-surface">
										<TRow>
											<THeadCell className="w-8 px-3">
												<Checkbox
													checked={allShownSelected}
													onChange={(e) => {
														const next = new Set(listSel);
														for (const id of shownIds) {
															if (e.target.checked) next.add(id);
															else next.delete(id);
														}
														setListSel(next);
													}}
													aria-label="Select all shown proxies"
												/>
											</THeadCell>
											<THeadCell className="px-2.5">Name</THeadCell>
											<THeadCell className="px-2.5">Type</THeadCell>
											<THeadCell className="px-2.5">Address</THeadCell>
											<THeadCell className="px-2.5">Auth</THeadCell>
											<THeadCell className="px-2.5">Last Used</THeadCell>
											<THeadCell className="px-2.5">Status</THeadCell>
											<THeadCell className="px-2.5">Health</THeadCell>
											<THeadCell className="px-3 text-right">Actions</THeadCell>
										</TRow>
									</THead>
									<tbody>
										{filteredProxies.map((p) => (
											<ProxyListRow
												key={p.id}
												proxy={p}
												selected={listSel.has(p.id)}
												onToggle={markListSel}
												batchResult={manyTests.get(p.id)}
												confirm={confirm}
											/>
										))}
									</tbody>
								</Table>
							</div>
						</>
					)}
				</Card>
			)}

			{tab === "free" && (
				<div className="space-y-6">
					<Card>
						<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
							<RefreshCw size={14} /> Fetch Free Proxies
						</h2>
						<p className="mb-4 text-xs text-muted-foreground">
							Sync fetches the latest free proxies from public lists. Test
							them, then move the good ones to the proxy list. Syncing
							replaces the previously staged list.
						</p>
						<syncFetcher.Form method="post" className="grid grid-cols-1 items-end gap-3 sm:grid-cols-12">
							<input type="hidden" name="intent" value="sync-free" />
							<div className="sm:col-span-4">
								<Label htmlFor="free-source">Source</Label>
								<Select id="free-source" name="source" defaultValue="proxyscrape-http">
									<option value="auto">Auto (try all sources)</option>
									{FREE_SOURCES.map((s) => (
										<option key={s.id} value={s.id}>
											{s.label}
										</option>
									))}
								</Select>
							</div>
							<div className="sm:col-span-5">
								<Label htmlFor="free-custom-url">Custom list URL (optional)</Label>
								<Input
									id="free-custom-url"
									name="custom_url"
									placeholder="e.g. Webshare or raw list URL"
									className="font-mono"
								/>
							</div>
							<div className="sm:col-span-1">
								<Label htmlFor="free-limit">Limit</Label>
								<Input
									id="free-limit"
									name="limit"
									type="number"
									min={1}
									max={500}
									defaultValue={100}
									title="Max proxies to fetch"
								/>
							</div>
							<div className="sm:col-span-2">
								<Button type="submit" disabled={syncRunning} className="w-full">
									{syncRunning ? <Spinner size={14} /> : <RefreshCw size={14} />}
									{syncRunning ? "Syncing…" : "Sync"}
								</Button>
							</div>
						</syncFetcher.Form>
					</Card>

					<Card>
						<div className="mb-3 flex flex-wrap items-center justify-between gap-3">
							<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
							<List size={14} />
							Staged Free Proxies
							<span className="text-xs font-normal text-muted-foreground">
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
										setLoadedSig(syncSig);
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
											disabled={selectedRows.length === 0 || batchFetcher.state !== "idle"}
										>
											{batchFetcher.state !== "idle" ? <Spinner size={13} /> : null}
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
											disabled={selectedRows.length === 0 || batchFetcher.state !== "idle"}
											className="gap-1.5"
										>
											{batchFetcher.state !== "idle" ? <Spinner size={13} /> : <Plus size={14} />}
											Move to Proxy List
										</Button>
									</batchFetcher.Form>
									<Button
										size="sm"
										variant="danger"
										className="gap-1.5"
										disabled={selected.size === 0}
										onClick={() => {
											setStaging((prev) =>
												prev.filter((r) => !selected.has(rowKey(r))),
											);
											setSelected(new Set());
										}}
									>
										<Trash2 size={14} /> Delete selected
									</Button>
								</div>
							)}
						</div>

						{staging.length === 0 && syncResults && (
							<div className="mb-3 rounded-lg border border-border bg-surface-2/50 p-4 text-sm text-muted-foreground">
								{syncResults.length > 0
									? `${syncResults.length} free proxies fetched. Click "Load" to review them.`
									: "No proxies found from this source. Try another source or a custom URL."}
							</div>
						)}

						{staging.length === 0 && !syncResults && (
							<p className="text-xs text-muted-foreground">
								Nothing staged yet. Hit Sync above to fetch the latest free
								proxies.
							</p>
						)}

						{staging.length > 0 && (
							<div className="max-h-80 overflow-y-auto rounded-lg border border-border">
								<Table className="min-w-[500px]">
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
											return (
												<StagingProxyRow
													key={key}
													row={r}
													selected={selected.has(key)}
													test={freeTests.get(key)}
													onToggle={markSelected}
													onTest={testStagedRow}
												/>
											);
										})}
									</tbody>
								</Table>
							</div>
						)}

						{batchFetcher.data?.moveResult && (
							<div className="mt-3 rounded-lg border border-border bg-surface-2/50 p-3 text-xs text-foreground">
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
							<h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
								<FlaskConical size={14} /> Test Tool
							</h2>
							<p className="text-xs text-muted-foreground">
								Test any proxy before adding or saving it.
							</p>
						</div>
						<customTestFetcher.Form
							method="post"
							className="grid grid-cols-1 items-end gap-2 sm:grid-cols-12"
						>
							<input type="hidden" name="intent" value="test-custom" />
							<div className="sm:col-span-2">
								<Label htmlFor="ct-type">Protocol</Label>
								<Select id="ct-type" name="type" defaultValue="http-connect" className="px-2">
									<option value="http-connect">HTTP CONNECT</option>
									<option value="socks5">SOCKS5</option>
								</Select>
							</div>
							<div className="sm:col-span-3">
								<Label htmlFor="ct-host">Host</Label>
								<Input
									id="ct-host"
									name="host"
									required
									placeholder="proxy.example.com"
									className="font-mono"
								/>
							</div>
							<div className="sm:col-span-2">
								<Label htmlFor="ct-port">Port</Label>
								<Input
									id="ct-port"
									name="port"
									type="number"
									required
									min={1}
									max={65535}
									placeholder="8080"
								/>
							</div>
							<div className="sm:col-span-2">
								<Label htmlFor="ct-user">Username</Label>
								<Input
									id="ct-user"
									name="username"
									placeholder="optional"
									autoComplete="off"
								/>
							</div>
							<div className="sm:col-span-2">
								<Label htmlFor="ct-pass">Password</Label>
								<Input
									id="ct-pass"
									name="password"
									type="password"
									placeholder="optional"
									autoComplete="new-password"
								/>
							</div>
							<div className="sm:col-span-1">
								<Button
									type="submit"
									className="w-full"
									disabled={customTestFetcher.state !== "idle"}
								>
									{customTestFetcher.state !== "idle" ? <Spinner size={14} /> : "Test"}
								</Button>
							</div>
						</customTestFetcher.Form>
						{customTestFetcher.data?.customTest && (
							<div
								role="status"
								className={`mt-3 rounded-lg border px-3 py-2 text-sm font-medium ${
									customTestFetcher.data.customTest.ok
										? "border-success/30 bg-success/10 text-success"
										: "border-danger/30 bg-danger/10 text-danger"
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
							<h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
								<Database size={14} />
								Saved Free Proxies (no auth)
								<span className="text-xs font-normal text-muted-foreground">
									{freeSaved.length} saved
								</span>
							</h2>
							{savedSelected.size > 0 && (
								<Form
									method="post"
									onSubmit={(e) => {
										e.preventDefault();
										const form = e.currentTarget;
										void confirm({
											title: "Delete selected proxies?",
											description: `${savedSelected.size} selected free proxies will be permanently removed.`,
											confirmLabel: "Delete",
											variant: "danger",
										}).then((ok) => {
											if (ok) submit(form);
										});
									}}
								>
									{[...savedSelected].map((id) => (
										<input key={id} type="hidden" name="ids" value={id} />
									))}
									<input type="hidden" name="intent" value="delete-many" />
									<Button
										type="submit"
										size="sm"
										variant="danger"
										className="gap-1.5"
									>
										<Trash2 size={14} /> Delete selected ({savedSelected.size})
									</Button>
								</Form>
							)}
						</div>

						{freeSaved.length === 0 && (
							<p className="text-xs text-muted-foreground">
								No auth-free proxies saved yet. Sync and move some above.
							</p>
						)}

						{freeSaved.length > 0 && (
							<div className="max-h-72 overflow-y-auto rounded-lg border border-border">
								<Table className="min-w-[640px]">
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
											<SavedProxyRow
												key={p.id}
												proxy={p}
												selected={savedSelected.has(p.id)}
												onToggle={markSavedSelected}
											/>
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
					<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
						<Download size={14} /> Import
					</h2>
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
							rows={6}
							placeholder={
								"socks5://user:pass@127.0.0.1:1080\nhttp-connect://127.0.0.1:3128\nproxy.example.com:8080"
							}
							className="font-mono"
						/>
						<Button type="submit">
							<Download size={14} /> Import
						</Button>
					</importFetcher.Form>
					{importFetcher.data?.importResult && (
						<div className="mt-4 rounded-lg border border-border bg-surface-2/50 p-3 text-xs text-foreground">
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
							<Globe size={14} /> Global Proxy
						</h2>
						<p className="mb-4 text-xs text-muted-foreground">
							Default fallback pool when neither a client API key nor a
							provider pool is assigned. Priority: client key → provider →
							global → direct.
						</p>
						<Form method="post" className="flex flex-wrap gap-2">
							<input type="hidden" name="intent" value="set-global" />
							<Select
								name="pool_id"
								defaultValue={loaderData.globalPoolId ?? ""}
								className="flex-1"
							>
								<option value="">None (direct)</option>
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
						<h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-foreground">
							<Layers size={14} /> Pools
						</h2>
						{loaderData.pools.length === 0 && (
							<p className="text-xs text-muted-foreground">
								No pools yet. Create one below.
							</p>
						)}
						<div className="space-y-4">
							{loaderData.pools.map((pool) => (
								<div key={pool.id} className="rounded-lg border border-border p-4">
									<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
										<h3 className="text-sm font-semibold text-foreground">
											{pool.name}
											<Badge tone="info" style="subtle" className="ml-2">
												{pool.strategy === "priority"
													? "priority"
													: pool.strategy === "random"
														? "random"
														: "round-robin"}
											</Badge>
											<span className="ml-1 text-xs font-normal text-muted-foreground">
												{pool.proxy_ids.length} proxies ·{" "}
												{pool.is_active ? "active" : "inactive"}
											</span>
										</h3>
										<Form
											method="post"
											onSubmit={(e) => {
												e.preventDefault();
												const form = e.currentTarget;
												void confirm({
													title: "Delete pool?",
													description: `Pool "${pool.name}" and its proxy assignments will be deleted.`,
													confirmLabel: "Delete",
													variant: "danger",
												}).then((ok) => {
													if (ok) submit(form);
												});
											}}
										>
											<input type="hidden" name="intent" value="delete-pool" />
											<input type="hidden" name="id" value={pool.id} />
											<Button
												size="icon"
												variant="danger"
												type="submit"
												title="Delete pool"
												aria-label="Delete pool"
											>
												<Trash2 size={14} />
											</Button>
										</Form>
									</div>
									<Form method="post">
										<input type="hidden" name="intent" value="update-pool" />
										<input type="hidden" name="id" value={pool.id} />
										<div className="mb-3 flex items-end gap-2">
											<div className="flex-1">
												<Label className="mb-1 text-xs">
													Rotation strategy
												</Label>
												<Select
													name="strategy"
													defaultValue={pool.strategy}
												>
													<option value="round_robin">
														Round-robin (rotate evenly)
													</option>
													<option value="priority">
														Priority (first in list first)
													</option>
													<option value="random">Random</option>
												</Select>
											</div>
										</div>
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
						<Form method="post" className="mt-4 grid grid-cols-1 items-end gap-2 sm:grid-cols-12">
							<input type="hidden" name="intent" value="create-pool" />
							<div className="sm:col-span-6">
								<Label htmlFor="new-pool-name">Pool name</Label>
								<Input
									id="new-pool-name"
									name="name"
									required
									placeholder="e.g. US Residential"
								/>
							</div>
							<div className="sm:col-span-4">
								<Label htmlFor="new-pool-strategy">Strategy</Label>
								<Select id="new-pool-strategy" name="strategy" defaultValue="round_robin">
									<option value="round_robin">Round-robin</option>
									<option value="priority">Priority</option>
									<option value="random">Random</option>
								</Select>
							</div>
							<div className="sm:col-span-2">
								<Button type="submit" className="w-full">
									Create pool
								</Button>
							</div>
						</Form>
					</Card>

					<Card>
						<h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-foreground">
							<Link2 size={14} /> Assignments
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
							<Table className="min-w-[520px]">
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
														onSubmit={(e) => {
															e.preventDefault();
															const form = e.currentTarget;
															void confirm({
																title: "Remove assignment?",
																description: "This pool assignment will be removed.",
																confirmLabel: "Remove",
																variant: "danger",
															}).then((ok) => {
																if (ok) submit(form);
															});
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
															variant="danger"
														>
															Remove
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
							className="mt-4 grid grid-cols-1 items-end gap-2 sm:grid-cols-12"
						>
							<input type="hidden" name="intent" value="assign" />
							<div className="sm:col-span-3">
								<Label htmlFor="assign-kind">Target kind</Label>
								<Select
									id="assign-kind"
									name="target_type"
									value={assignTargetType}
									onChange={(e) =>
										setAssignTargetType(
											e.target.value === "client_key" ? "client_key" : "provider",
										)
									}
								>
									<option value="provider">Provider</option>
									<option value="client_key">API Key</option>
								</Select>
							</div>
							<div className="sm:col-span-4">
								<Label htmlFor="assign-target">
									{assignTargetType === "provider" ? "Provider" : "API Key"}
								</Label>
								<Select
									id="assign-target"
									name="target_id"
									disabled={
										assignTargetType === "provider"
											? loaderData.providers.length === 0
											: loaderData.apiKeys.length === 0
									}
								>
									{assignTargetType === "provider" ? (
										loaderData.providers.length === 0 ? (
											<option value="">No providers configured</option>
										) : (
											loaderData.providers.map((p) => (
												<option key={p.id} value={p.id}>
													{p.name}
												</option>
											))
										)
									) : loaderData.apiKeys.length === 0 ? (
										<option value="">No client API keys configured</option>
									) : (
										loaderData.apiKeys.map((k) => (
											<option key={k.id} value={String(k.id)}>
												{k.name}
											</option>
										))
									)}
								</Select>
							</div>
							<div className="sm:col-span-3">
								<Label htmlFor="assign-pool">Proxy pool</Label>
								<Select
									id="assign-pool"
									name="pool_id"
									disabled={loaderData.pools.length === 0}
								>
									{loaderData.pools.length === 0 ? (
										<option value="">Create a pool first</option>
									) : (
										loaderData.pools.map((pool) => (
											<option key={pool.id} value={pool.id}>
												{pool.name}
											</option>
										))
									)}
								</Select>
							</div>
							<div className="sm:col-span-2">
								<Button
									type="submit"
									className="w-full"
									disabled={
										loaderData.pools.length === 0 ||
										(assignTargetType === "provider"
											? loaderData.providers.length === 0
											: loaderData.apiKeys.length === 0)
									}
								>
									Assign
								</Button>
							</div>
						</Form>
					</Card>
				</div>
			)}

			{dialog}
		</div>
	);
}
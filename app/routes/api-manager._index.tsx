import { Form, Link, useSubmit } from "react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Route } from "./+types/api-manager._index";
import {
	Download,
	Eye,
	KeyRound,
	Lock,
	LockOpen,
	Plus,
	RotateCw,
	Search,
	Trash2,
	Settings,
} from "lucide-react";

export function meta() {
	return [{ title: "API Keys | UniRoute" }];
}
import { requireSession } from "../.server/auth";
import {
	listClientKeys,
	isRequireApiKey,
	setRequireApiKey,
} from "../.server/client-key";
import { computeStatus, type KeyStatus } from "../.server/key-enforce";
import { usageThisMonth, usageToday } from "../.server/key-usage";
import {
	deleteKey,
	reactivateKey,
	rotateKey,
	suspendKey,
} from "../.server/key-ops";
import { applyBulk, type BulkAction } from "../.server/key-bulk";
import { decryptKey } from "../.server/key-crypto";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button, buttonClass } from "../components/ui/button";
import { Input, Select, Label, Checkbox } from "../components/ui/field";
import { CopyButton } from "../components/ui/copy-button";
import { EmptyState } from "../components/ui/empty-state";
import { Table, THead, THeadCell, TRow, TCell } from "../components/ui/table";
import { StatCard } from "../components/ui/stat-card";
import { UsageBar } from "../components/ui/usage-bar";
import { Tooltip } from "../components/ui/tooltip";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function loader() {
	const keys = listClientKeys().map((k) => {
		const month = usageThisMonth(k.id);
		const today = usageToday(k.id);
		return {
			key: k,
			month,
			today,
			status: computeStatus(k, month),
			revealable: !!k.key_enc,
		};
	});
	const requireApiKey = isRequireApiKey();
	const revealAllowed = process.env.ALLOW_API_KEY_REVEAL === "1";
	const total = keys.length;
	const active = keys.filter((k) => k.status === "active").length;
	const restricted = keys.filter(
		(k) =>
			(k.key.allowed_models && k.key.allowed_models.length > 0) ||
			k.key.strict_ip === 1,
	).length;
	const totalRequests = keys.reduce((acc, k) => acc + k.month.requests, 0);
	return {
		keys,
		requireApiKey,
		revealAllowed,
		counts: { total, active, restricted, totalRequests },
	};
}

type Row = Awaited<ReturnType<typeof loader>>["keys"][number];

type Result = {
	newlyRotated?: { key: string; id: number }[];
	revealed?: { id: number; key: string } | null;
	notice?: { ok: boolean; message: string };
} | null;

export async function action({ request }: Route.ActionArgs) {
	const denied = requireSession(request);
	if (denied) return denied;
	const form = await request.formData();
	const intent = String(form.get("intent"));

	if (intent === "require") {
		const enabled = form.get("enabled") === "1";
		setRequireApiKey(enabled);
		return { notice: { ok: true, message: `API key requirement ${enabled ? "enabled" : "disabled"}` } } satisfies Result;
	}
	const id = Number(form.get("id") ?? 0);

	if (intent === "suspend") {
		suspendKey(id);
		return { notice: { ok: true, message: `Key #${id} suspended` } } satisfies Result;
	}
	if (intent === "reactivate") {
		reactivateKey(id);
		return { notice: { ok: true, message: `Key #${id} reactivated` } } satisfies Result;
	}
	if (intent === "rotate") {
		const rotated = rotateKey(id);
		return { newlyRotated: [rotated] } satisfies Result;
	}
	if (intent === "delete") {
		deleteKey(id);
		return { notice: { ok: true, message: `Key #${id} deleted` } } satisfies Result;
	}
	if (intent === "reveal") {
		const key = listClientKeys().find((k) => k.id === id);
		if (!key || !key.key_enc || process.env.ALLOW_API_KEY_REVEAL !== "1") {
			return { revealed: null } satisfies Result;
		}
		try {
			return {
				revealed: { id, key: decryptKey(key.key_enc) },
			} satisfies Result;
		} catch {
			return { revealed: null } satisfies Result;
		}
	}

	if (intent === "bulk") {
		const action = String(form.get("bulk_action")) as BulkAction;
		const status = String(form.get("status_filter") ?? "");
		const beforeRaw = String(form.get("created_before") ?? "").trim();
		const createdBefore = beforeRaw
			? new Date(beforeRaw).getTime() / 1000
			: undefined;
		const selected = String(form.get("selected_ids") ?? "")
			.split(",")
			.map((s) => Number(s))
			.filter((n) => n > 0) as number[];
		const res = applyBulk(
			{
				status: status === "any" ? undefined : (status as never),
				createdBefore,
			},
			action,
			{},
			selected.length > 0 ? selected : undefined,
		);
		if (action === "rotate") {
			return { newlyRotated: res.rotated ?? [] } satisfies Result;
		}
		const affected = res.done;
		const failed = res.failed;
		return {
			notice: {
				ok: failed === 0,
				message:
					`Bulk ${action}: ${affected} key${affected === 1 ? "" : "s"} updated` +
					(failed > 0 ? `, ${failed} failed` : ""),
			},
		} satisfies Result;
	}

	return null;
}

const STATUS_TONE: Record<KeyStatus, BadgeTone> = {
	active: "success",
	near_limit: "warning",
	suspended: "danger",
	expired: "neutral",
};

const STATUS_LABEL: Record<KeyStatus, string> = {
	active: "Active",
	near_limit: "Near Limit",
	suspended: "Locked",
	expired: "Expired",
};

function masked(key: Row["key"]): string {
	return `${key.key_prefix}…${key.key_hash.slice(0, 4)}`;
}

function pct(value: number, total: number): number {
	if (!total) return 0;
	return Math.min(100, Math.round((value / total) * 100));
}

function usageTone(p: number): "success" | "warning" | "danger" {
	return p >= 80 ? "danger" : p >= 50 ? "warning" : "success";
}

export default function ApiManager({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const { keys, requireApiKey, revealAllowed, counts } = loaderData;
	const result = actionData as Result | undefined;
	const { toast } = useToast();
	const lastResultRef = useRef<Result | undefined>(undefined);
	useEffect(() => {
		if (result === lastResultRef.current) return;
		lastResultRef.current = result;
		if (result && result.revealed === null) {
			toast({
				title: "Could not reveal key",
				description: "Reveal is disabled or this key has no stored secret.",
				variant: "error",
			});
		}
		if (result?.notice) {
			toast({
				title: result.notice.ok ? "Done" : "Action failed",
				description: result.notice.message,
				variant: result.notice.ok ? "success" : "error",
			});
		}
		if (result?.newlyRotated && result.newlyRotated.length === 0) {
			toast({
				title: "No keys matched",
				description: "Bulk rotate found no matching keys.",
				variant: "info",
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [result]);
	const [query, setQuery] = useState("");
	const [statusFilter, setStatusFilter] = useState("any");
	const [selected, setSelected] = useState<Set<number>>(new Set());

	useEffect(() => {
		const validIds = new Set(keys.map((r) => r.key.id));
		setSelected((prev) => {
			if (prev.size === 0) return prev;
			const next = new Set([...prev].filter((id) => validIds.has(id)));
			return next.size === prev.size ? prev : next;
		});
	}, [keys]);

	const filtered = keys.filter(
		(r) =>
			(statusFilter === "any" || r.status === statusFilter) &&
			(r.key.name.toLowerCase().includes(query.toLowerCase()) ||
				masked(r.key).toLowerCase().includes(query.toLowerCase())),
	);

	const toggle = (id: number) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const reveal = result?.revealed;
	const rotated = result?.newlyRotated;

	return (
		<div>
			<PageHeader
				title="API Manager"
				icon={<KeyRound size={20} />}
				subtitle="Manage API keys for all applications & clients."
				actions={
					<>
						<Link to="/api-manager/templates" className={buttonClass("outline", "sm")}>
							Templates
						</Link>
						<Link to="/api-manager/groups" className={buttonClass("outline", "sm")}>
							Groups
						</Link>
						<Link to="/api-manager/create" className={buttonClass("primary", "sm")}>
							<Plus size={16} /> Create New Key
						</Link>
					</>
				}
			/>

			{rotated && rotated.length > 0 ? (
				<div className="mb-4 rounded-xl border border-warning/35 bg-warning/10 p-4 text-sm">
					<p className="font-semibold text-foreground">
						New keys below are shown only once. Copy them now:
					</p>
					{rotated.map((r) => (
						<div key={r.id} className="mt-2 flex items-center gap-2">
							<code className="break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground">
								{r.key}
							</code>
							<CopyButton text={r.key} label="Copy" />
						</div>
					))}
				</div>
			) : null}

			{reveal ? (
				<div className="mb-4 rounded-xl border border-warning/35 bg-warning/10 p-4 text-sm">
					<p className="font-semibold text-foreground">
						Full key (key #{reveal.id}):
					</p>
					<div className="mt-2 flex items-center gap-2">
						<code className="break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground">
							{reveal.key}
						</code>
						<CopyButton text={reveal.key} label="Copy" />
					</div>
				</div>
			) : null}

			<div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
				<StatCard title="Total Keys" value={counts.total} />
				<StatCard
					title="Active Keys"
					value={counts.active}
					accent="bg-success"
				/>
				<StatCard
					title="Restricted Keys"
					value={counts.restricted}
					accent="bg-warning"
				/>
				<StatCard
					title="Requests (month)"
					value={counts.totalRequests.toLocaleString()}
					accent="bg-info"
				/>
			</div>

			<Card
				padded={false}
				className="mb-4 flex flex-wrap items-center gap-3 p-3"
			>
				<div className="relative w-full sm:w-64">
					<Search
						size={14}
						className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
					/>
					<Input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						placeholder="Search keys…"
						aria-label="Search keys"
						autoComplete="off"
						className="pl-8"
					/>
				</div>
				<Select
					value={statusFilter}
					onChange={(e) => setStatusFilter(e.target.value)}
					aria-label="Filter by status"
					className="w-full sm:w-44"
				>
					<option value="any">All status</option>
					<option value="active">Active</option>
					<option value="near_limit">Near Limit</option>
					<option value="suspended">Locked</option>
					<option value="expired">Expired</option>
				</Select>

				<div className="ml-auto flex flex-wrap items-center gap-2">
					<Form method="post" className="flex items-center">
						<input type="hidden" name="intent" value="require" />
						<input
							type="hidden"
							name="enabled"
							value={requireApiKey ? "0" : "1"}
						/>
						<Button
							type="submit"
							size="sm"
							variant={requireApiKey ? "primary" : "outline"}
							title="Master switch: require an API key for all requests"
						>
							Require API key: {requireApiKey ? "ON" : "OFF"}
						</Button>
					</Form>
					{keys.length > 0 ? <ExportDrawer /> : null}
				</div>
			</Card>

			{selected.size > 0 ? (
				<div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-primary/30 bg-primary/8 p-3 text-sm">
					<span className="font-medium text-foreground">
						{selected.size} selected
					</span>
					<BulkRow ids={selected} setSelected={setSelected} />
				</div>
			) : null}

			{filtered.length === 0 ? (
				<Card>
					{keys.length === 0 ? (
						<EmptyState
							icon={<KeyRound size={20} />}
							title="No API keys yet"
							description="Create a key to start routing requests with budgets and rate limits."
							action={
								<Link
									to="/api-manager/create"
									className={buttonClass("primary", "sm")}
								>
									<Plus size={14} /> Create New Key
								</Link>
							}
						/>
					) : (
						<EmptyState
							icon={<Search size={20} />}
							title="No keys match your filter"
							description="Try clearing your search term or status filter."
							action={
								<Button
									variant="outline"
									size="sm"
									onClick={() => {
										setQuery("");
										setStatusFilter("any");
									}}
								>
									Clear filters
								</Button>
							}
						/>
					)}
				</Card>
			) : (
				<Card padded={false}>
					<Table className="min-w-[780px]">
						<THead>
							<tr>
								<THeadCell className="pr-2">
									<Checkbox
										aria-label="Select all keys"
										checked={
											filtered.length > 0 &&
											filtered.every((r) => selected.has(r.key.id))
										}
										onChange={(e) =>
											setSelected(
												e.target.checked
													? new Set(filtered.map((r) => r.key.id))
													: new Set(),
											)
										}
									/>
								</THeadCell>
								<THeadCell>Name</THeadCell>
								<THeadCell>Key</THeadCell>
								<THeadCell>Status</THeadCell>
								<THeadCell>Usage</THeadCell>
								<THeadCell>Budget</THeadCell>
								<THeadCell>Actions</THeadCell>
							</tr>
						</THead>
						<tbody>
							{filtered.map((r) => {
								const budget = r.key.budget?.monthly;
								const usagePct =
									budget && budget > 0 ? pct(r.month.cost, budget) : null;
								return (
									<TRow key={r.key.id}>
										<TCell className="pr-2">
											<Checkbox
												aria-label={`Select ${r.key.name}`}
												checked={selected.has(r.key.id)}
												onChange={() => toggle(r.key.id)}
											/>
										</TCell>
										<TCell>
											<Link
												to={`/api-manager/${r.key.id}`}
												prefetch="intent"
												className="font-medium text-primary hover:underline"
											>
												{r.key.name}
											</Link>
											{r.key.description ? (
												<p className="text-xs text-muted-foreground">
													{r.key.description}
												</p>
											) : null}
										</TCell>
										<TCell className="font-mono text-xs text-muted-foreground">
											{masked(r.key)}
										</TCell>
										<TCell>
											<Badge tone={STATUS_TONE[r.status]}>
												{STATUS_LABEL[r.status]}
											</Badge>
										</TCell>
										<TCell className="text-xs text-muted-foreground">
											{r.month.requests.toLocaleString()} req ·{" "}
											{r.month.cost.toFixed(4)} USD
										</TCell>
										<TCell>
											{usagePct !== null ? (
												<div className="w-24">
													<UsageBar
														value={usagePct}
														max={100}
														tone={usageTone(usagePct)}
													/>
													<span className="text-xs text-muted-foreground">
														{usagePct}%
													</span>
												</div>
											) : (
												<span className="text-xs text-muted-foreground">-</span>
											)}
										</TCell>
										<TCell>
											<div className="flex items-center gap-1">
												<CopyButton text={masked(r.key)} label="Copy key prefix" />
												<Form method="post">
													<input type="hidden" name="intent" value="reveal" />
													<input type="hidden" name="id" value={r.key.id} />
													<Button
														type="submit"
														variant="ghost"
														size="icon"
														disabled={!revealAllowed || !r.revealable}
														title={
															!revealAllowed
																? "Reveal is disabled. Set ALLOW_API_KEY_REVEAL=1 to enable."
																: !r.revealable
																	? "This key has no stored secret to reveal"
																	: "Reveal full key"
														}
														aria-label="Reveal full key"
													>
														<Eye size={14} />
													</Button>
												</Form>
												<RowAction
													intent="rotate"
													id={r.key.id}
													title="Rotate"
													icon={<RotateCw size={14} />}
												/>
												{r.status === "suspended" ? (
													<RowAction
														intent="reactivate"
														id={r.key.id}
														title="Reactivate"
														icon={<LockOpen size={14} />}
													/>
												) : (
													<RowAction
														intent="suspend"
														id={r.key.id}
														title="Suspend"
														icon={<Lock size={14} />}
													/>
												)}
												<RowAction
													intent="delete"
													id={r.key.id}
													title="Delete"
													icon={<Trash2 size={14} />}
													danger
												/>
												<Link
													to={`/api-manager/${r.key.id}`}
													prefetch="intent"
													title="Manage / Edit"
													aria-label="Manage / Edit"
													className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-glass-hover hover:text-foreground"
												>
													<Settings size={14} />
												</Link>
											</div>
										</TCell>
									</TRow>
								);
							})}
						</tbody>
					</Table>
				</Card>
			)}
		</div>
	);
}

function RowAction({
	intent,
	id,
	title,
	icon,
	danger,
}: {
	intent: "rotate" | "suspend" | "reactivate" | "delete";
	id: number;
	title: string;
	icon: ReactNode;
	danger?: boolean;
}) {
	const { dialog, confirm } = useConfirm();
	const confirmMsg =
		intent === "delete"
			? {
					title: "Delete this API key?",
					description: "This action cannot be undone.",
					confirmLabel: "Delete",
					variant: "danger" as const,
				}
			: intent === "rotate"
				? {
						title: "Rotate this key?",
						description: "The old key stays valid for the grace period.",
						confirmLabel: "Rotate",
						variant: "primary" as const,
					}
				: intent === "suspend"
					? {
							title: "Suspend this API key?",
							description: "Requests with this key will be rejected.",
							confirmLabel: "Suspend",
							variant: "primary" as const,
						}
					: null;

	const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
		if (!confirmMsg) return;
		e.preventDefault();
		const form = e.currentTarget;
		const ok = await confirm(confirmMsg);
		if (ok) form.submit();
	};

	return (
		<>
			<Form method="post" onSubmit={handleSubmit}>
				<input type="hidden" name="intent" value={intent} />
				<input type="hidden" name="id" value={id} />
				<Button
					type="submit"
					variant={danger ? "danger" : "ghost"}
					size="icon"
					title={title}
					aria-label={title}
				>
					{icon}
				</Button>
			</Form>
			{dialog}
		</>
	);
}

function BulkRow({
	ids,
	setSelected,
}: {
	ids: Set<number>;
	setSelected: (s: Set<number>) => void;
}) {
	const { dialog, confirm } = useConfirm();
	const submit = useSubmit();

	const runAction = async (action: "suspend" | "reactivate" | "rotate" | "delete") => {
		const msg =
			action === "delete"
				? {
						title: `Delete ${ids.size} API key${ids.size === 1 ? "" : "s"}?`,
						description: "This action cannot be undone.",
						confirmLabel: "Delete",
						variant: "danger" as const,
					}
				: action === "suspend"
					? {
							title: `Suspend ${ids.size} API key${ids.size === 1 ? "" : "s"}?`,
							description: "Requests using these keys will be rejected.",
							confirmLabel: "Suspend",
							variant: "primary" as const,
						}
					: action === "rotate"
						? {
								title: `Rotate ${ids.size} API key${ids.size === 1 ? "" : "s"}?`,
								description: "The old keys stay valid for the grace period.",
								confirmLabel: "Rotate",
								variant: "primary" as const,
							}
						: null;
		if (msg) {
			const ok = await confirm(msg);
			if (!ok) return;
		}
		const fd = new FormData();
		fd.set("intent", "bulk");
		fd.set("bulk_action", action);
		fd.set("selected_ids", Array.from(ids).join(","));
		submit(fd, { method: "post" });
		setSelected(new Set());
	};

	return (
		<>
			<div className="inline-flex flex-wrap items-center gap-1.5">
				<Button type="button" variant="outline" size="sm" onClick={() => runAction("suspend")}>
					Suspend
				</Button>
				<Button type="button" variant="outline" size="sm" onClick={() => runAction("reactivate")}>
					Reactivate
				</Button>
				<Button type="button" variant="outline" size="sm" onClick={() => runAction("rotate")}>
					Rotate
				</Button>
				<Button type="button" variant="danger" size="sm" onClick={() => runAction("delete")}>
					Delete
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={() => setSelected(new Set())}
				>
					Clear
				</Button>
			</div>
			{dialog}
		</>
	);
}

function ExportDrawer() {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onMouseDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onMouseDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onMouseDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	return (
		<div ref={rootRef} className="relative">
			<Button
				type="button"
				size="sm"
				variant="outline"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
			>
				<Download size={14} /> Export
			</Button>
			{open ? (
				<div className="dialog-pop absolute right-0 z-40 mt-2 w-72 rounded-xl border border-border-strong bg-surface p-4 shadow-xl">
					<Form
						method="get"
						action="/api-manager/export"
						reloadDocument
						className="space-y-3"
						onSubmit={() => setOpen(false)}
					>
						<p className="text-xs font-semibold text-foreground">Export keys</p>
						<div>
							<Label htmlFor="export-status">Status</Label>
							<Select id="export-status" name="status" controlSize="sm">
								<option value="any">All status</option>
								<option value="active">Active</option>
								<option value="suspended">Locked</option>
								<option value="expired">Expired</option>
							</Select>
						</div>
						<div>
							<Label htmlFor="export-before">Created before</Label>
							<Input controlSize="sm" type="date" id="export-before" name="created_before" />
						</div>
						<div>
							<Label htmlFor="export-format">Format</Label>
							<Select id="export-format" name="format" controlSize="sm">
								<option value="csv">CSV</option>
								<option value="json">JSON</option>
							</Select>
						</div>
						<div className="flex justify-end gap-2 border-t border-border pt-3">
							<Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
								Close
							</Button>
							<Button type="submit" size="sm">
								<Download size={13} /> Download
							</Button>
						</div>
					</Form>
				</div>
			) : null}
		</div>
	);
}

import { Form } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/api-manager.groups";
import { Pencil, Users, Trash2, Plus, X } from "lucide-react";

export function meta() {
	return [{ title: "API Key Groups | UniRoute" }];
}
import { requireLoaderSession, requireSession } from "../.server/auth";
import {
	listGroups,
	createGroup,
	deleteGroup,
	updateGroup,
	setGroupMembers,
	type KeyGroup,
} from "../.server/key-groups";
import { query } from "../.server/db";
import { flushUsageQueue } from "../.server/key-usage";
import { listClientKeys } from "../.server/client-key";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Label, Checkbox } from "../components/ui/field";
import { EmptyState } from "../components/ui/empty-state";
import { UsageBar } from "../components/ui/usage-bar";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function loader({ request }: Route.LoaderArgs) {
	requireLoaderSession(request);
	flushUsageQueue();
	const now = new Date();
	const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
	const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

	const keys = listClientKeys().map((k) => ({
		id: k.id,
		name: k.name,
		masked: `${k.key_prefix}…${k.key_hash.slice(0, 4)}`,
	}));

	const memberRows = query(
		"SELECT group_id, key_id FROM key_group_members",
	).all() as Array<{ group_id: number; key_id: number }>;
	const membersByGroup = new Map<number, number[]>();
	for (const r of memberRows) {
		let arr = membersByGroup.get(r.group_id);
		if (!arr) {
			arr = [];
			membersByGroup.set(r.group_id, arr);
		}
		arr.push(r.key_id);
	}

	const usageRows = query(
		`SELECT m.group_id AS group_id,
		        COALESCE(SUM(u.requests), 0) AS requests,
		        COALESCE(SUM(u.prompt_tokens), 0) AS prompt_tokens,
		        COALESCE(SUM(u.completion_tokens), 0) AS completion_tokens,
		        COALESCE(SUM(u.cost), 0) AS cost
		   FROM key_group_members m
		   JOIN key_usage_daily u ON u.key_id = m.key_id
		  WHERE u.date >= ? AND u.date < ?
		  GROUP BY m.group_id`,
	).all(from, to) as Array<{
		group_id: number;
		requests: number;
		prompt_tokens: number;
		completion_tokens: number;
		cost: number;
	}>;
	const usageByGroup = new Map(
		usageRows.map((u) => [
			u.group_id,
			{
				requests: Number(u.requests),
				promptTokens: Number(u.prompt_tokens),
				completionTokens: Number(u.completion_tokens),
				cost: Number(u.cost),
			},
		]),
	);

	const groups = listGroups().map((g) => ({
		group: g,
		members: membersByGroup.get(g.id) ?? [],
		usage: usageByGroup.get(g.id) ?? {
			requests: 0,
			promptTokens: 0,
			completionTokens: 0,
			cost: 0,
		},
	}));
	return { keys, groups };
}

export async function action({ request }: Route.ActionArgs) {
	const denied = requireSession(request);
	if (denied) return denied;
	const form = await request.formData();
	const intent = String(form.get("intent"));
	const num = (name: string): number | undefined => {
		const raw = String(form.get(name) ?? "").trim();
		if (!raw) return undefined;
		const n = Number(raw);
		return Number.isFinite(n) ? n : undefined;
	};

	if (intent === "create") {
		const name = String(form.get("name") ?? "").trim();
		if (!name) {
			return { notice: { ok: false, message: "Group name is required." } };
		}
		try {
			createGroup(
				name,
				String(form.get("description") ?? "").trim() || null,
				{
					monthly_budget: num("budget"),
					tokens_per_month: num("tokens"),
				},
				String(form.get("member_ids") ?? "")
					.split(",")
					.map((s) => Number(s))
					.filter((n) => n > 0),
			);
			return { notice: { ok: true, message: `Group "${name}" created` } };
		} catch (err) {
			const msg =
				err instanceof Error && /UNIQUE/i.test(err.message)
					? `A group named "${name}" already exists.`
					: err instanceof Error
						? err.message
						: "Failed to create group.";
			return { notice: { ok: false, message: msg } };
		}
	}
	if (intent === "delete") {
		deleteGroup(Number(form.get("id")));
		return { notice: { ok: true, message: "Group deleted" } };
	}
	if (intent === "update") {
		updateGroup(Number(form.get("id")), {
			sharedQuota: {
				monthly_budget: num("budget"),
				tokens_per_month: num("tokens"),
			},
		});
		return { notice: { ok: true, message: "Group updated" } };
	}
	if (intent === "members") {
		const gid = Number(form.get("id"));
		const memberIds = String(form.get("member_ids") ?? "")
			.split(",")
			.map((s) => Number(s))
			.filter((n) => n > 0);
		setGroupMembers(gid, memberIds);
		return { notice: { ok: true, message: "Group members saved" } };
	}
	return null;
}

export default function Groups({ loaderData, actionData }: Route.ComponentProps) {
	const { keys, groups } = loaderData;
	const [creating, setCreating] = useState(false);
	const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
	const notice = (
		actionData as { notice?: { ok: boolean; message: string } } | undefined
	)?.notice;
	const { toast } = useToast();
	const lastNoticeRef = useRef<{ ok: boolean; message: string } | undefined>(
		undefined,
	);
	useEffect(() => {
		if (notice === lastNoticeRef.current) return;
		lastNoticeRef.current = notice;
		if (notice) {
			if (notice.ok) {
				setCreating(false);
				setEditingGroupId(null);
			}
			toast({
				title: notice.ok ? "Done" : "Action failed",
				description: notice.message,
				variant: notice.ok ? "success" : "error",
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [notice]);

	return (
		<div className="mx-auto max-w-4xl">
			<PageHeader
				title="API Key Groups / Teams"
				icon={<Users size={20} />}
				subtitle="Group keys to share budgets and quotas."
				backTo="/api-manager"
				backLabel="Back to API Keys"
				actions={
					<Button type="button" variant={creating ? "outline" : "primary"} onClick={() => setCreating((v) => !v)}>
						{creating ? <X size={16} /> : <Plus size={16} />}
						{creating ? "Close" : "New Group"}
					</Button>
				}
			/>

			{creating ? (
				<Card className="mb-6">
					<Form method="post" className="space-y-3">
						<input type="hidden" name="intent" value="create" />
						<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
							<div>
								<Label htmlFor="group-name">Group name</Label>
								<Input
									id="group-name"
									name="name"
									required
									placeholder="engineering-team"
									autoComplete="off"
								/>
							</div>
							<div>
								<Label htmlFor="group-description">Description</Label>
								<Input
									id="group-description"
									name="description"
									autoComplete="off"
								/>
							</div>
							<div>
								<Label htmlFor="group-budget">Shared budget ($/month)</Label>
								<Input
									id="group-budget"
									name="budget"
									type="number"
									step="any"
									autoComplete="off"
								/>
							</div>
							<div>
								<Label htmlFor="group-tokens">Shared tokens/month</Label>
								<Input
									id="group-tokens"
									name="tokens"
									type="number"
									autoComplete="off"
								/>
							</div>
						</div>
						<div>
							<Label>Members</Label>
							<MemberSelect name="member_ids" keys={keys} />
						</div>
						<Button type="submit">Create Group</Button>
					</Form>
				</Card>
			) : null}

			{groups.length === 0 ? (
				<Card>
					<EmptyState
						icon={<Users size={20} />}
						title="No groups yet"
						description="Create a group to share budgets across keys."
					/>
				</Card>
			) : (
				<div className="space-y-4">
					{groups.map(({ group, members, usage }) => {
						const quota = group.shared_quota;
						const budgetPct =
							quota?.monthly_budget && quota.monthly_budget > 0
								? Math.min(
										100,
										Math.round((usage.cost / quota.monthly_budget) * 100),
									)
								: null;
						const tokensPct =
							quota?.tokens_per_month && quota.tokens_per_month > 0
								? Math.min(
										100,
										Math.round(
											((usage.promptTokens + usage.completionTokens) /
												quota.tokens_per_month) *
												100,
										),
									)
								: null;
						return (
							<Card key={group.id}>
								<div className="mb-3 flex items-start justify-between gap-3">
									<div>
										<h2 className="text-lg font-semibold text-foreground">
											{group.name}
										</h2>
										{group.description ? (
											<p className="text-sm text-muted-foreground">
												{group.description}
											</p>
										) : null}
									</div>
									<div className="flex items-center gap-1.5">
										<Button
											type="button"
											variant="outline"
											size="sm"
											onClick={() =>
												setEditingGroupId(editingGroupId === group.id ? null : group.id)
											}
										>
											{editingGroupId === group.id ? <X size={13} /> : <Pencil size={13} />}
											{editingGroupId === group.id ? "Close" : "Edit quota"}
										</Button>
										<DeleteGroupButton id={group.id} />
									</div>
								</div>

								{editingGroupId === group.id ? (
									<Form
										method="post"
										className="mb-4 grid grid-cols-1 items-end gap-3 rounded-lg border border-primary/25 bg-primary/5 p-3 sm:grid-cols-3"
									>
										<input type="hidden" name="intent" value="update" />
										<input type="hidden" name="id" value={group.id} />
										<div>
											<Label htmlFor={`edit-budget-${group.id}`}>Shared budget ($/mo)</Label>
											<Input
												id={`edit-budget-${group.id}`}
												name="budget"
												type="number"
												step="any"
												defaultValue={quota?.monthly_budget ?? ""}
											/>
										</div>
										<div>
											<Label htmlFor={`edit-tokens-${group.id}`}>Shared tokens/mo</Label>
											<Input
												id={`edit-tokens-${group.id}`}
												name="tokens"
												type="number"
												defaultValue={quota?.tokens_per_month ?? ""}
											/>
										</div>
										<Button type="submit" size="md">
											Save quota
										</Button>
									</Form>
								) : null}

								<div className="mb-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
									<QuotaBox
										label="Shared budget"
										pct={budgetPct}
										text={
											quota?.monthly_budget != null
												? `$${usage.cost.toFixed(2)} / $${quota.monthly_budget}`
												: "not set"
										}
									/>
									<QuotaBox
										label="Shared tokens/mo"
										pct={tokensPct}
										text={
											quota?.tokens_per_month != null
												? `${(usage.promptTokens + usage.completionTokens).toLocaleString()} / ${quota.tokens_per_month.toLocaleString()}`
												: "not set"
										}
									/>
								</div>

								<Form
									method="post"
									className="flex flex-wrap items-center gap-2"
								>
									<input type="hidden" name="intent" value="members" />
									<input type="hidden" name="id" value={group.id} />
									<MemberSelect
										name="member_ids"
										keys={keys}
										defaultValue={members}
									/>
									<Button type="submit" variant="outline" size="sm">
										Save members
									</Button>
								</Form>
							</Card>
						);
					})}
				</div>
			)}
		</div>
	);
}

function DeleteGroupButton({ id }: { id: number }) {
	const { dialog, confirm } = useConfirm();
	const handleDelete = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const form = e.currentTarget;
		const ok = await confirm({
			title: "Delete group?",
			description: "This removes the group and its shared quota.",
			confirmLabel: "Delete",
			variant: "danger",
		});
		if (ok) form.submit();
	};
	return (
		<>
			<Form method="post" onSubmit={handleDelete}>
				<input type="hidden" name="intent" value="delete" />
				<input type="hidden" name="id" value={id} />
				<Button
					type="submit"
					variant="danger"
					size="icon"
					aria-label="Delete group"
				>
					<Trash2 size={14} />
				</Button>
			</Form>
			{dialog}
		</>
	);
}

function QuotaBox({
	label,
	pct,
	text,
}: {
	label: string;
	pct: number | null;
	text: string;
}) {
	return (
		<div className="rounded-lg border border-border p-3">
			<p className="mb-1 text-xs uppercase text-muted-foreground">{label}</p>
			<p className="text-sm font-medium text-foreground">{text}</p>
			{pct !== null ? (
				<div className="mt-2">
					<UsageBar
						value={pct}
						max={100}
						tone={pct >= 80 ? "danger" : pct >= 50 ? "warning" : "success"}
					/>
				</div>
			) : null}
		</div>
	);
}

function MemberSelect({
	name,
	keys,
	defaultValue = [],
}: {
	name: string;
	keys: Array<{ id: number; name: string; masked: string }>;
	defaultValue?: number[];
}) {
	const [selected, setSelected] = useState<Set<number>>(new Set(defaultValue));
	const defaultKey = defaultValue.join(",");
	useEffect(() => {
		setSelected(new Set(defaultValue));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [defaultKey]);
	const toggle = (id: number) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	return (
		<div>
			{keys.length === 0 ? (
				<p className="text-xs text-muted-foreground">No client API keys available yet.</p>
			) : (
				<div className="flex flex-wrap gap-2">
					{keys.map((k) => (
						<label
							key={k.id}
							className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-xs"
						>
							<Checkbox
								checked={selected.has(k.id)}
								onChange={() => toggle(k.id)}
								aria-label={`Toggle ${k.name}`}
							/>
							{k.name} <span className="font-mono text-muted-foreground">{k.masked}</span>
						</label>
					))}
				</div>
			)}
			<input type="hidden" name={name} value={Array.from(selected).join(",")} />
		</div>
	);
}

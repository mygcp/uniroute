import { Form } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/api-manager.groups";
import { Users, Trash2, Plus } from "lucide-react";
import {
	listGroups,
	createGroup,
	deleteGroup,
	updateGroup,
	setGroupMembers,
	groupMembers,
	groupUsage,
	type KeyGroup,
} from "../.server/key-groups";
import { listClientKeys } from "../.server/client-key";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Label, Checkbox } from "../components/ui/field";
import { EmptyState } from "../components/ui/empty-state";
import { UsageBar } from "../components/ui/usage-bar";
import { useConfirm } from "../components/ui/confirm-dialog";

export function loader() {
	const keys = listClientKeys().map((k) => ({
		id: k.id,
		name: k.name,
		masked: `${k.key_prefix}…${k.key_hash.slice(0, 4)}`,
	}));
	const groups = listGroups().map((g) => ({
		group: g,
		members: groupMembers(g.id),
		usage: groupUsage(g),
	}));
	return { keys, groups };
}

export async function action({ request }: Route.ActionArgs) {
	const form = await request.formData();
	const intent = String(form.get("intent"));
	const num = (name: string): number | undefined => {
		const raw = String(form.get(name) ?? "").trim();
		if (!raw) return undefined;
		const n = Number(raw);
		return Number.isFinite(n) ? n : undefined;
	};

	if (intent === "create") {
		createGroup(
			String(form.get("name") ?? "").trim(),
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
		return null;
	}
	if (intent === "delete") {
		deleteGroup(Number(form.get("id")));
		return null;
	}
	if (intent === "update") {
		updateGroup(Number(form.get("id")), {
			sharedQuota: {
				monthly_budget: num("budget"),
				tokens_per_month: num("tokens"),
			},
		});
		return null;
	}
	if (intent === "members") {
		const gid = Number(form.get("id"));
		const memberIds = String(form.get("member_ids") ?? "")
			.split(",")
			.map((s) => Number(s))
			.filter((n) => n > 0);
		setGroupMembers(gid, memberIds);
		return null;
	}
	return null;
}

export default function Groups({ loaderData }: Route.ComponentProps) {
	const { keys, groups } = loaderData;
	const [creating, setCreating] = useState(false);

	return (
		<div className="mx-auto max-w-4xl">
			<PageHeader
				title="API Key Groups / Teams"
				icon={<Users size={20} />}
				subtitle="Group keys to share budgets and quotas."
				actions={
					<Button type="button" onClick={() => setCreating((v) => !v)}>
						<Plus size={16} /> New Group
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
									<DeleteGroupButton id={group.id} />
								</div>

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
	const toggle = (id: number) =>
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	return (
		<div>
			<div className="flex flex-wrap gap-2">
				{keys.map((k) => (
					<label
						key={k.id}
						className="flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-1 text-xs"
					>
						<Checkbox
							checked={selected.has(k.id)}
							onChange={() => toggle(k.id)}
							aria-label={`Toggle ${k.name}`}
						/>
						{k.name} <span className="text-muted-foreground">{k.masked}</span>
					</label>
				))}
			</div>
			<input type="hidden" name={name} value={Array.from(selected).join(",")} />
		</div>
	);
}

import { Form } from "react-router";
import type { Route } from "./+types/api-manager.templates";
import { LayoutTemplate, Trash2 } from "lucide-react";
import {
	listTemplates,
	createTemplate,
	deleteTemplate,
} from "../.server/key-templates";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/field";
import { EmptyState } from "../components/ui/empty-state";
import { Table, THead, THeadCell, TRow, TCell } from "../components/ui/table";
import { useConfirm } from "../components/ui/confirm-dialog";

export function loader() {
	return { templates: listTemplates() };
}

export async function action({ request }: Route.ActionArgs) {
	const form = await request.formData();
	const intent = String(form.get("intent"));
	if (intent === "delete") {
		deleteTemplate(Number(form.get("id")));
		return null;
	}
	if (intent === "create") {
		const parseList = (name: string): string[] | undefined => {
			const raw = String(form.get(name) ?? "").trim();
			const items = raw
				.split(/[\n,]+/)
				.map((s) => s.trim())
				.filter(Boolean);
			return items.length > 0 ? items : undefined;
		};
		const num = (name: string): number | undefined => {
			const raw = String(form.get(name) ?? "").trim();
			if (!raw) return undefined;
			const n = Number(raw);
			return Number.isFinite(n) ? n : undefined;
		};
		createTemplate(
			String(form.get("name") ?? "").trim(),
			String(form.get("description") ?? "").trim() || null,
			{
				name: String(form.get("name") ?? "").trim(),
				allowedModels: parseList("allowed_models"),
				budget: { monthly: num("budget_monthly") },
				quota: {
					rpm: num("quota_rpm"),
					tpm: num("quota_tpm"),
					concurrent_requests: num("quota_concurrent"),
				},
				scopes: [],
			},
		);
		return null;
	}
	return null;
}

export default function Templates({ loaderData }: Route.ComponentProps) {
	const { templates } = loaderData;
	return (
		<div className="mx-auto max-w-3xl">
			<PageHeader
				title="API Key Templates"
				icon={<LayoutTemplate size={20} />}
				subtitle="Reusable configurations for creating API keys."
			/>

			<Card className="mb-6">
				<Form method="post" className="space-y-3">
					<input type="hidden" name="intent" value="create" />
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div>
							<Label htmlFor="template-name">Name</Label>
							<Input
								id="template-name"
								name="name"
								required
								placeholder="production-default"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="template-description">Description</Label>
							<Input
								id="template-description"
								name="description"
								autoComplete="off"
							/>
						</div>
					</div>
					<div>
						<Label htmlFor="template-models">
							Allowed Models (comma separated)
						</Label>
						<Input
							id="template-models"
							name="allowed_models"
							placeholder="gpt-4o, claude-3.5"
							autoComplete="off"
						/>
					</div>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						<div>
							<Label htmlFor="template-budget">Monthly Budget ($)</Label>
							<Input
								id="template-budget"
								name="budget_monthly"
								type="number"
								step="any"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="template-rpm">Requests/Min</Label>
							<Input
								id="template-rpm"
								name="quota_rpm"
								type="number"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="template-tpm">Tokens/Min</Label>
							<Input
								id="template-tpm"
								name="quota_tpm"
								type="number"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="template-concurrent">Concurrent</Label>
							<Input
								id="template-concurrent"
								name="quota_concurrent"
								type="number"
								autoComplete="off"
							/>
						</div>
					</div>
					<Button type="submit">Create Template</Button>
				</Form>
			</Card>

			{templates.length === 0 ? (
				<Card>
					<EmptyState
						icon={<LayoutTemplate size={20} />}
						title="No templates yet"
						description="Create a template to reuse key configurations."
					/>
				</Card>
			) : (
				<Card padded={false}>
					<Table>
						<THead>
							<tr>
								<THeadCell>Name</THeadCell>
								<THeadCell>Description</THeadCell>
								<THeadCell>Models</THeadCell>
								<THeadCell className="pr-0">Actions</THeadCell>
							</tr>
						</THead>
						<tbody>
							{templates.map((t) => (
								<TRow key={t.id}>
									<TCell className="font-medium text-foreground">
										{t.name}
									</TCell>
									<TCell className="text-muted-foreground">
										{t.description ?? "—"}
									</TCell>
									<TCell className="text-xs text-muted-foreground">
										{t.config.allowedModels?.join(", ") || "all"}
									</TCell>
									<TCell className="pr-0">
										<DeleteTemplateButton id={t.id} name={t.name} />
									</TCell>
								</TRow>
							))}
						</tbody>
					</Table>
				</Card>
			)}
		</div>
	);
}

function DeleteTemplateButton({ id, name }: { id: number; name: string }) {
	const { dialog, confirm } = useConfirm();
	const handleDelete = async (e: React.FormEvent<HTMLFormElement>) => {
		e.preventDefault();
		const form = e.currentTarget;
		const ok = await confirm({
			title: "Delete template?",
			description: `"${name}" will be permanently removed.`,
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
					aria-label={`Delete template ${name}`}
				>
					<Trash2 size={14} />
				</Button>
			</Form>
			{dialog}
		</>
	);
}

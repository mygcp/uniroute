import { Form, Link, useNavigation } from "react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Route } from "./+types/api-manager.create";
import { KeyRound } from "lucide-react";

export function meta() {
	return [{ title: "Create API Key | UniRoute" }];
}
import { requireLoaderSession, requireSession } from "../.server/auth";
import {
	createClientKey,
	type CreateClientKeyInput,
} from "../.server/client-key";
import { enqueueWebhook } from "../.server/webhook";
import {
	getModelSuggestions,
	getProviderSuggestions,
	getStructuredSuggestions,
} from "../.server/suggest";
import { listTemplates, type KeyTemplate } from "../.server/key-templates";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Button, buttonClass } from "../components/ui/button";
import { Spinner } from "../components/ui/feedback";
import { Input, Label, Select, Checkbox } from "../components/ui/field";
import { CopyButton } from "../components/ui/copy-button";
import { TagInput } from "../components/ui/tag-input";
import { useToast } from "../components/ui/toast";

export function loader({ request }: Route.LoaderArgs) {
	requireLoaderSession(request);
	return {
		modelSuggestions: getModelSuggestions(),
		providerSuggestions: getProviderSuggestions(),
		structuredSuggestions: getStructuredSuggestions(),
		templates: listTemplates().map((t) => ({
			id: t.id,
			name: t.name,
			description: t.description,
			config: t.config,
		})),
	};
}

export async function action({ request }: Route.ActionArgs) {
	const denied = requireSession(request);
	if (denied) return denied;
	const form = await request.formData();
	const parseList = (name: string): string[] | null => {
		const raw = String(form.get(name) ?? "").trim();
		if (!raw) return null;
		const items = raw
			.split(/[\n,]+/)
			.map((s) => s.trim())
			.filter(Boolean);
		return items.length > 0 ? items : null;
	};
	const num = (name: string): number | undefined => {
		const raw = String(form.get(name) ?? "").trim();
		if (!raw) return undefined;
		const n = Number(raw);
		return Number.isFinite(n) ? n : undefined;
	};
	const date = (name: string): number | undefined => {
		const raw = String(form.get(name) ?? "").trim();
		if (!raw) return undefined;
		const t = new Date(raw).getTime();
		return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
	};

	const accessHoursEnabled = form.get("access_enabled") === "1";
	const accessHours =
		accessHoursEnabled ||
		form.get("access_timezone") ||
		form.get("access_days") ||
		form.get("access_start") ||
		form.get("access_end")
			? {
					enabled: accessHoursEnabled,
					timezone:
						String(form.get("access_timezone") ?? "").trim() || undefined,
					allowed_days: parseList("access_days") ?? undefined,
					start_time:
						String(form.get("access_start") ?? "").trim() || undefined,
					end_time: String(form.get("access_end") ?? "").trim() || undefined,
				}
			: undefined;

	const scopesRaw = parseListUnchecked(form, "scopes");
	const manageScope = form.get("manage_scope") === "1";

	const input: CreateClientKeyInput = {
		name: String(form.get("name") ?? "").trim() || "Untitled",
		prefix: String(form.get("prefix") ?? "").trim() || "sk-",
		description: String(form.get("description") ?? "").trim() || null,
		allowedModels: parseList("allowed_models"),
		modelOverride: String(form.get("model_override") ?? "").trim() || null,
		pinnedProviderId:
			String(form.get("pinned_provider_id") ?? "").trim() || null,
		blockedModels: parseList("blocked_models"),
		allowedProviders: parseList("allowed_providers"),
		blockedProviders: parseList("blocked_providers"),
		budget: {
			monthly: num("budget_monthly"),
			daily: num("budget_daily"),
			per_request: num("budget_per_request"),
		},
		quota: {
			tokens_per_month: num("quota_tokens"),
			requests_per_day: num("quota_req_day"),
			concurrent_requests: num("quota_concurrent"),
			rpm: num("quota_rpm"),
			tpm: num("quota_tpm"),
		},
		alertThreshold: num("alert_threshold"),
		autoBlock: form.get("auto_block") === "1",
		ipWhitelist: parseList("ip_whitelist"),
		ipBlacklist: parseList("ip_blacklist"),
		strictIp: form.get("strict_ip") === "1",
		accessHours,
		expiresAt: date("expires_at"),
		rotationIntervalDays: num("rotation_interval_days"),
		gracePeriodDays: num("grace_period_days"),
		webhookUrl: String(form.get("webhook_url") ?? "").trim() || null,
		scopes:
			manageScope && !scopesRaw.includes("manage")
				? [...scopesRaw, "manage"]
				: scopesRaw.length > 0
					? scopesRaw
					: manageScope
						? ["manage"]
						: null,
	};

	let newKey: string;
	let newId: number;
	try {
		const created = createClientKey(input);
		newKey = created.key;
		newId = created.id;
	} catch (err) {
		return {
			error: err instanceof Error ? err.message : "Failed to create key",
		};
	}
	if (input.webhookUrl) {
		enqueueWebhook({
			keyId: newId,
			event: "created",
			url: input.webhookUrl,
			payload: {
				event: "created",
				key_id: newId,
				key_prefix: input.prefix ?? "sk-",
				at: Date.now(),
			},
		});
	}
	return { newlyCreatedKey: newKey, id: newId, name: input.name };
}

function parseListUnchecked(form: FormData, name: string): string[] {
	return form
		.getAll(name)
		.flatMap((v) =>
			String(v ?? "")
				.split(/[\n,]+/)
				.map((s) => s.trim()),
		)
		.filter(Boolean);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
	return (
		<Card>
			<h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>
			{children}
		</Card>
	);
}

export default function CreateKey({
	loaderData,
	actionData,
}: Route.ComponentProps) {
	const {
		modelSuggestions,
		providerSuggestions,
		structuredSuggestions,
		templates,
	} = loaderData;
	const formRef = useRef<HTMLFormElement>(null);
	const [allowedModels, setAllowedModels] = useState("");
	const [blockedModels, setBlockedModels] = useState("");
	const created = actionData as
		| { id?: number; newlyCreatedKey?: string; name?: string; error?: string }
		| undefined;

	useEffect(() => {
		if (created?.newlyCreatedKey) {
			formRef.current?.reset();
			setAllowedModels("");
			setBlockedModels("");
		}
	}, [created?.newlyCreatedKey]);

	const { toast } = useToast();
	const lastErrorRef = useRef<string | undefined>(undefined);
	useEffect(() => {
		if (created?.error === lastErrorRef.current) return;
		lastErrorRef.current = created?.error;
		if (created?.error) {
			toast({
				title: "Could not create key",
				description: created.error,
				variant: "error",
			});
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [created?.error]);

	const applyTemplate = (template: KeyTemplate["config"]) => {
		const el = formRef.current;
		if (!el) return;
		const set = (name: string, value: string | undefined) => {
			const field = el.elements.namedItem(name) as
				| HTMLInputElement
				| HTMLTextAreaElement
				| null;
			if (field && value != null) field.value = value;
		};
		set("name", template.name);
		set("description", template.description ?? "");
		setAllowedModels(template.allowedModels?.join(", ") ?? "");
		set(
			"budget_monthly",
			template.budget?.monthly != null ? String(template.budget.monthly) : "",
		);
		set(
			"budget_daily",
			template.budget?.daily != null ? String(template.budget.daily) : "",
		);
		set(
			"budget_per_request",
			template.budget?.per_request != null
				? String(template.budget.per_request)
				: "",
		);
		set(
			"quota_tokens",
			template.quota?.tokens_per_month != null
				? String(template.quota.tokens_per_month)
				: "",
		);
		set(
			"quota_req_day",
			template.quota?.requests_per_day != null
				? String(template.quota.requests_per_day)
				: "",
		);
		set(
			"quota_concurrent",
			template.quota?.concurrent_requests != null
				? String(template.quota.concurrent_requests)
				: "",
		);
		set(
			"quota_rpm",
			template.quota?.rpm != null ? String(template.quota.rpm) : "",
		);
		set(
			"quota_tpm",
			template.quota?.tpm != null ? String(template.quota.tpm) : "",
		);
		set("ip_whitelist", template.ipWhitelist?.join(", ") ?? "");
		set("ip_blacklist", template.ipBlacklist?.join(", ") ?? "");
		set("webhook_url", template.webhookUrl ?? "");
		set("allowed_providers", template.allowedProviders?.join(", ") ?? "");
		set("blocked_providers", template.blockedProviders?.join(", ") ?? "");
		setBlockedModels(template.blockedModels?.join(", ") ?? "");
		toast({ title: "Template applied", description: "Form fields have been prefilled.", variant: "info" });
	};

	const navigation = useNavigation();
	const submitting = navigation.state !== "idle";

	return (
		<div className="mx-auto max-w-3xl">
			<PageHeader
				title="Create New API Key"
				icon={<KeyRound size={20} />}
				subtitle="Generate a key with budgets, quotas, and access controls."
				backTo="/api-manager"
				backLabel="Back to API Keys"
			/>

			{created?.newlyCreatedKey ? (
				<div className="mb-6 rounded-xl border border-warning/35 bg-warning/10 p-4 text-sm">
					<p className="font-semibold text-foreground">
						Key created. Copy it now, it will not be shown again.
					</p>
					<div className="mt-2 flex items-start gap-2">
						<code className="break-all rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground">
							{created.newlyCreatedKey}
						</code>
						<CopyButton text={created.newlyCreatedKey} label="Copy" />
					</div>
					<div className="mt-3 flex flex-wrap gap-2">
						<Link
							to={`/api-manager/${created.id}`}
							className={buttonClass("primary", "sm")}
						>
							View key details
						</Link>
						<Link
							to="/api-manager"
							className={buttonClass("outline", "sm")}
						>
							Back to API Keys
						</Link>
					</div>
				</div>
			) : null}

			<div className="mb-4 flex items-end gap-3">
				<div className="flex-1">
					<Label htmlFor="template-select">Create from Template:</Label>
					<Select
						id="template-select"
						onChange={(e) => {
							const t = templates.find((x) => x.id === Number(e.target.value));
							if (t) applyTemplate(t.config);
						}}
					>
						<option value="">None</option>
						{templates.map((t) => (
							<option key={t.id} value={t.id}>
								{t.name}
							</option>
						))}
					</Select>
				</div>
			</div>

			<Form ref={formRef} method="post" className="space-y-4">
				<Section title="Information">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div>
							<Label htmlFor="name">Key Name</Label>
							<Input
								id="name"
								name="name"
								required
								placeholder="e.g. production-client"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="description">Description</Label>
							<Input
								id="description"
								name="description"
								placeholder="Optional"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="prefix">Prefix</Label>
							<Input
								id="prefix"
								name="prefix"
								defaultValue="sk-"
								autoComplete="off"
							/>
						</div>
					</div>
				</Section>

				<Section title="Permissions">
					<div className="flex flex-wrap gap-4 text-sm">
						{[
							["chat", "Chat Completions", true],
							["embeddings", "Embeddings"],
							["image", "Image Generation"],
							["audio", "Audio Transcription"],
							["rerank", "Reranking"],
						].map(([id, label]) => (
							<label key={id as string} className="flex items-center gap-2">
								<Checkbox
									name="scopes"
									value={id as string}
									defaultChecked={Boolean(label === "Chat Completions")}
								/>
								{label}
							</label>
						))}
					</div>
					<label className="mt-3 flex items-center gap-2 text-sm">
						<Checkbox name="manage_scope" value="1" />
						Management API Access (manage scope)
					</label>
				</Section>

				<Section title="Model Access">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div>
							<Label htmlFor="allowed_models">
								Allowed Models (empty = all)
							</Label>
							<TagInput
								id="allowed_models"
								name="allowed_models"
								options={structuredSuggestions}
								value={allowedModels}
								onChange={setAllowedModels}
								placeholder="gpt-4o, claude-3.5, gemini-1.5-pro"
							/>
						</div>
						<div>
							<Label htmlFor="blocked_models">Blocked Models</Label>
							<TagInput
								id="blocked_models"
								name="blocked_models"
								options={structuredSuggestions}
								value={blockedModels}
								onChange={setBlockedModels}
								placeholder="gpt-4o-mini, llama-3-8b"
							/>
						</div>
						<div>
							<Label htmlFor="allowed_providers">
								Allowed Providers (empty = all)
							</Label>
							<Input
								id="allowed_providers"
								name="allowed_providers"
								placeholder="openai, anthropic"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="blocked_providers">Blocked Providers</Label>
							<Input
								id="blocked_providers"
								name="blocked_providers"
								placeholder="deepseek"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="model_override">Model Override (advanced)</Label>
							<Input
								id="model_override"
								name="model_override"
								list="model-suggestions"
								placeholder="e.g. gpt-4o-mini"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="pinned_provider_id">
								Pinned Provider (advanced)
							</Label>
							<Input
								id="pinned_provider_id"
								name="pinned_provider_id"
								list="provider-suggestions"
								placeholder="e.g. openai"
								autoComplete="off"
							/>
						</div>
					</div>
					<datalist id="model-suggestions">
						{modelSuggestions.map((m) => (
							<option key={m} value={m} />
						))}
					</datalist>
					<datalist id="provider-suggestions">
						{providerSuggestions.map((p) => (
							<option key={p} value={p} />
						))}
					</datalist>
				</Section>

				<Section title="Budget & Quota">
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
						{[
							[
								"budget_monthly",
								"Monthly Budget (USD)",
								"USD cap per month, e.g. 100",
							],
							[
								"budget_daily",
								"Daily Budget (USD)",
								"USD cap per day, e.g. 10",
							],
							[
								"budget_per_request",
								"Per-request (USD)",
								"Max USD per request, e.g. 0.002",
							],
							[
								"quota_tokens",
								"Tokens/Month",
								"Token cap per month, e.g. 100000",
							],
							["quota_req_day", "Requests/Day", "Daily request cap, e.g. 1000"],
							["quota_concurrent", "Concurrent", "Max active sessions, e.g. 5"],
							["quota_rpm", "Requests/Min", "Rate limit per minute, e.g. 60"],
							["quota_tpm", "Tokens/Min", "Token rate per minute, e.g. 100000"],
							[
								"alert_threshold",
								"Alert at (0..1)",
								"Fraction of budget before warning, e.g. 0.8",
							],
						].map(([name, label, placeholder]) => (
							<div key={name as string}>
								<Label htmlFor={name as string}>{label}</Label>
								<Input
									id={name as string}
									name={name}
									type="number"
									step="any"
									placeholder={placeholder as string}
									autoComplete="off"
								/>
							</div>
						))}
					</div>
					<label className="mt-3 flex items-center gap-2 text-sm">
						<Checkbox name="auto_block" value="1" defaultChecked />
						Auto-block when budget exceeded
					</label>
				</Section>

				<Section title="Security">
					<div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
						<div>
							<Label htmlFor="expires_at">Expires</Label>
							<Input id="expires_at" name="expires_at" type="date" />
						</div>
						<div>
							<Label htmlFor="rotation_interval_days">
								Rotation interval (days)
							</Label>
							<Input
								id="rotation_interval_days"
								name="rotation_interval_days"
								type="number"
								placeholder="e.g. 30"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="grace_period_days">Grace period (days)</Label>
							<Input
								id="grace_period_days"
								name="grace_period_days"
								type="number"
								placeholder="e.g. 7"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="webhook_url">Webhook URL</Label>
							<Input
								id="webhook_url"
								name="webhook_url"
								type="url"
								placeholder="https://my-app.com/webhook"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="ip_whitelist">IP Whitelist (CIDR / IP)</Label>
							<Input
								id="ip_whitelist"
								name="ip_whitelist"
								placeholder="192.168.1.0/24, 10.0.0.1"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="ip_blacklist">IP Blacklist</Label>
							<Input
								id="ip_blacklist"
								name="ip_blacklist"
								placeholder="203.0.113.0/24"
								autoComplete="off"
							/>
						</div>
					</div>
					<label className="mt-3 flex items-center gap-2 text-sm">
						<Checkbox name="strict_ip" value="1" />
						Strict IP (only whitelisted IPs may access)
					</label>
				</Section>

				<Section title="Time-Based Access">
					<label className="mb-3 flex cursor-pointer items-center gap-2 text-sm">
						<Checkbox name="access_enabled" value="1" />
						Restrict key to specific access hours
					</label>
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
						<div>
							<Label htmlFor="access_timezone">Timezone</Label>
							<Input
								id="access_timezone"
								name="access_timezone"
								placeholder="UTC"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="access_days">Allowed days</Label>
							<Input
								id="access_days"
								name="access_days"
								placeholder="monday, tuesday,…"
								autoComplete="off"
							/>
						</div>
						<div>
							<Label htmlFor="access_start">Start (HH:mm)</Label>
							<Input
								id="access_start"
								name="access_start"
								type="time"
								defaultValue="08:00"
							/>
						</div>
						<div>
							<Label htmlFor="access_end">End (HH:mm)</Label>
							<Input
								id="access_end"
								name="access_end"
								type="time"
								defaultValue="18:00"
							/>
						</div>
					</div>
				</Section>

				<div className="flex items-center justify-end gap-3">
					<Link
						to="/api-manager"
						prefetch="intent"
						className={buttonClass("outline", "md")}
					>
						Cancel
					</Link>
					<Button type="submit" disabled={submitting}>
						{submitting ? <Spinner size={14} /> : null}
						{submitting ? "Creating…" : "Create API Key"}
					</Button>
				</div>
			</Form>
		</div>
	);
}

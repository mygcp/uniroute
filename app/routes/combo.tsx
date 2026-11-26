import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Form, useActionData, useSubmit } from "react-router";
import type { Route } from "./+types/combo";

export function meta() {
	return [{ title: "Model Combos | UniRoute" }];
}
import {
	ArrowDown,
	ArrowUp,
	GitBranch,
	Layers,
	Link2,
	Pencil,
	Plus,
	Shield,
	Trash2,
	UserRound,
	X,
} from "lucide-react";
import {
	listCombos,
	createCombo,
	updateCombo,
	deleteCombo,
	getComboById,
	validateComboInput,
	type ComboStep,
} from "../.server/combo";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { CopyButton } from "../components/ui/copy-button";
import { Input, Label, Select, Textarea } from "../components/ui/field";
import { EmptyState } from "../components/ui/empty-state";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";
import { requireLoaderSession, requireSession } from "../.server/auth";
import { query } from "../.server/db";

type ProviderOption = { id: string; name: string };
type ModelOption = { model_name: string; provider_id: string };
type AccountOption = { id: number; provider_id: string; label: string | null };
type PoolOption = { id: number; name: string };

export function loader({ request }: Route.LoaderArgs) {
	requireLoaderSession(request);
	const combos = listCombos();
	const providers =
		(query(
			"SELECT id, name FROM providers ORDER BY id",
		).all() as unknown as ProviderOption[]) ?? [];
	const modelRows =
		(query(
			"SELECT model_name, provider_id FROM models WHERE is_active = 1 ORDER BY model_name",
		).all() as unknown as ModelOption[]) ?? [];
	const accounts =
		(query(
			"SELECT id, provider_id, label FROM provider_credentials WHERE is_active = 1 ORDER BY provider_id, id",
		).all() as unknown as AccountOption[]) ?? [];
	const pools =
		(query(
			"SELECT id, name FROM proxy_pools WHERE is_active = 1 ORDER BY name",
		).all() as unknown as PoolOption[]) ?? [];
	return { combos, providers, modelRows, accounts, pools };
}

type ActionMsg = { error?: string; saved?: string; deleted?: string };

/** Resolve comma-separated account input ("key 1, key 2") into credential ids. */
function resolveAccountIds(providerId: string, raw: string | null): number[] {
	const text = (raw ?? "").trim();
	if (!text) return [];
	const lower = text.toLowerCase();
	if (lower === "dynamic" || lower === "auto" || lower === "all") return [];
	const ids: number[] = [];
	for (const token of text.split(",")) {
		const t = token.trim();
		if (!t) continue;
		if (/^#?\d+$/.test(t)) {
			ids.push(Number(t.replace("#", "")));
			continue;
		}
		const rows = query(
			"SELECT id FROM provider_credentials WHERE provider_id = ? AND label = ? AND is_active = 1",
		).all(providerId, t) as { id: number }[];
		for (const r of rows) ids.push(r.id);
	}
	return [...new Set(ids)];
}

export async function action({ request }: Route.ActionArgs) {
	const denied = requireSession(request);
	if (denied) return denied;
	const form = await request.formData();
	const section = String(form.get("section"));

	if (section === "delete") {
		const id = Number(form.get("id"));
		const prev = getComboById(id);
		deleteCombo(id);
		return {
			deleted: `Combo "${prev?.name ?? `#${id}`}" deleted`,
		} satisfies ActionMsg;
	}

	if (section === "create" || section === "update") {
		const id = form.get("id") ? Number(form.get("id")) : undefined;
		const stepCount = Number(form.get("step_count") ?? 0);
		const steps = [];
		for (let i = 0; i < stepCount; i += 1) {
			const modelIds = form
				.getAll(`step_model_ids_${i}`)
				.map((m) => String(m).trim())
				.filter((m) => m.length > 0);
			if (modelIds.length === 0) continue;
			const providerId =
				String(form.get(`step_provider_${i}`) ?? "").trim() || null;
			steps.push({
				modelIds,
				providerId,
				accountIds: providerId
					? resolveAccountIds(
							providerId,
							String(form.get(`step_account_${i}`) ?? ""),
						)
					: [],
				prompt: String(form.get(`step_prompt_${i}`) ?? "").trim() || null,
			});
		}
		const input = {
			name: String(form.get("name") ?? "").trim(),
			strategy: String(form.get("strategy") ?? "priority") as
				| "priority"
				| "pipeline",
			steps,
			config: {
				proxy_pool_id: (() => {
					const raw = String(form.get("proxy_pool_id") ?? "").trim();
					const n = raw === "" ? NaN : Number(raw);
					return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
				})(),
			},
		};
		const error = validateComboInput(input);
		if (error) return { error } satisfies ActionMsg;
		try {
			if (section === "create") {
				const combo = createCombo(input);
				return { saved: `Combo "${combo.name}" created` } satisfies ActionMsg;
			}
			const prev = id != null ? getComboById(id) : undefined;
			updateCombo(id!, {
				...input,
				config: { ...(prev?.config ?? {}), ...input.config },
			});
			return { saved: `Combo "${input.name}" updated` } satisfies ActionMsg;
		} catch (err) {
			return {
				error: err instanceof Error ? err.message : String(err),
			} satisfies ActionMsg;
		}
	}

	return null;
}

function modelsForProvider(
	modelRows: ModelOption[],
	providerId: string,
): string[] {
	return modelRows
		.filter((m) => m.provider_id === providerId)
		.map((m) => m.model_name);
}
function accountsForProvider(
	accounts: AccountOption[],
	providerId: string,
): AccountOption[] {
	return accounts.filter((a) => a.provider_id === providerId);
}

type StepDraft = {
	provider: string;
	models: string[];
	accountText: string;
	prompt: string;
};

function draftFromStep(
	step: ComboStep | undefined,
	accounts: AccountOption[],
): StepDraft {
	if (!step) return { provider: "", models: [], accountText: "", prompt: "" };
	const accs = accountsForProvider(accounts, step.providerId ?? "");
	const labels = step.accountIds.map(
		(aid) => accs.find((a) => a.id === aid)?.label ?? `#${aid}`,
	);
	return {
		provider: step.providerId ?? "",
		models: step.modelIds,
		accountText: labels.join(", ") || "dynamic",
		prompt: step.prompt ?? "",
	};
}

function StepEditor({
	prefix,
	strategy,
	providers,
	modelRows,
	accounts,
	initialSteps,
}: {
	prefix: string;
	strategy: "priority" | "pipeline";
	providers: ProviderOption[];
	modelRows: ModelOption[];
	accounts: AccountOption[];
	initialSteps?: ComboStep[];
}) {
	const [steps, setSteps] = useState<StepDraft[]>(() => {
		const base =
			initialSteps && initialSteps.length > 0 ? initialSteps : [undefined];
		return base.map((s) => draftFromStep(s, accounts));
	});
	const [openPrompts, setOpenPrompts] = useState<Record<number, boolean>>(() => {
		const map: Record<number, boolean> = {};
		(initialSteps ?? []).forEach((s, idx) => {
			if (s.prompt?.trim()) map[idx] = true;
		});
		return map;
	});

	const taken = useMemo(() => {
		const set = new Set<string>();
		for (const s of steps) for (const m of s.models) set.add(m);
		return set;
	}, [steps]);

	const updateStep = (i: number, patch: Partial<StepDraft>) => {
		setSteps((prev) =>
			prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
		);
	};

	const addStep = () => {
		setSteps((prev) => [
			...prev,
			{ provider: "", models: [], accountText: "", prompt: "" },
		]);
	};

	const removeStep = (i: number) => {
		setSteps((prev) =>
			prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i),
		);
	};

	const moveStep = (i: number, dir: -1 | 1) => {
		const target = i + dir;
		setSteps((prev) => {
			if (target < 0 || target >= prev.length) return prev;
			const next = [...prev];
			const [item] = next.splice(i, 1);
			next.splice(target, 0, item);
			return next;
		});
	};

	const stepNoun = strategy === "pipeline" ? "Stage" : "Fallback Tier";
	const connectorLabel =
		strategy === "pipeline" ? "Passes output to next stage" : "On failure / rate limit, fall back to";

	return (
		<div className="space-y-2">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div>
					<h3 className="text-sm font-semibold text-foreground">
						Routing Steps ({steps.length})
					</h3>
					<p className="text-xs text-muted-foreground">
						{strategy === "pipeline"
							? "Stages run top to bottom. Each stage receives the previous output."
							: "Requests try Tier 1 first, then automatically fall back in order."}
					</p>
				</div>
				<Button type="button" variant="outline" size="sm" onClick={addStep}>
					<Plus size={13} aria-hidden="true" />
					Add {stepNoun}
				</Button>
			</div>

			<div className="space-y-0">
				{steps.map((s, i) => {
					const providerOpt = providers.find(
						(p) => p.id === s.provider || p.name === s.provider,
					);
					const providerId = providerOpt?.id ?? "";
					const availableModels = modelsForProvider(modelRows, providerId).filter(
						(m) => !taken.has(m),
					);
					const accountOpts = accountsForProvider(accounts, providerId);
					const showPrompt =
						strategy === "pipeline" || Boolean(openPrompts[i]) || Boolean(s.prompt.trim());

					return (
						<div key={i}>
							<div className="rounded-xl border border-border bg-surface">
								<div className="flex flex-wrap items-center justify-between gap-2 rounded-t-[11px] border-b border-border bg-surface-2/60 px-3.5 py-2">
									<span className="flex min-w-0 flex-wrap items-center gap-2">
										<span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-primary/15 font-mono text-xs font-semibold text-primary">
											{i + 1}
										</span>
										<span className="text-xs font-semibold text-foreground">
											{stepNoun} {i + 1}
										</span>
										{providerOpt ? (
											<Badge tone="info" style="subtle">
												{providerOpt.name || providerOpt.id}
											</Badge>
										) : (
											<Badge tone="warning" style="subtle">
												Select provider
											</Badge>
										)}
										{s.models.length > 0 ? (
											<Badge tone="neutral" style="subtle">
												{s.models.length} {s.models.length === 1 ? "model" : "models"}
											</Badge>
										) : null}
									</span>
									<div className="flex items-center gap-1">
										<Button
											type="button"
											size="icon"
											variant="ghost"
											disabled={i === 0}
											onClick={() => moveStep(i, -1)}
											title="Move step up"
											aria-label={`Move step ${i + 1} up`}
										>
											<ArrowUp size={13} aria-hidden="true" />
										</Button>
										<Button
											type="button"
											size="icon"
											variant="ghost"
											disabled={i === steps.length - 1}
											onClick={() => moveStep(i, 1)}
											title="Move step down"
											aria-label={`Move step ${i + 1} down`}
										>
											<ArrowDown size={13} aria-hidden="true" />
										</Button>
										<Button
											type="button"
											size="icon"
											variant="danger"
											disabled={steps.length <= 1}
											onClick={() => removeStep(i)}
											title={
												steps.length <= 1
													? "At least one step is required"
													: "Remove this step"
											}
											aria-label={`Remove step ${i + 1}`}
										>
											<Trash2 size={13} aria-hidden="true" />
										</Button>
									</div>
								</div>

								<div className="space-y-3 p-3.5">
									<div className="grid gap-3 lg:grid-cols-3">
										<div className="min-w-0">
											<Label htmlFor={`${prefix}_provider_${i}`}>Provider</Label>
											<Select
												id={`${prefix}_provider_${i}`}
												name={`${prefix}_provider_${i}`}
												value={providerId}
												onChange={(e) =>
													updateStep(i, {
														provider: e.target.value,
														models: [],
														accountText: "",
													})
												}
											>
												<option value="">Choose a provider...</option>
												{providers.map((p) => {
													const cnt = modelsForProvider(modelRows, p.id).length;
													return (
														<option key={p.id} value={p.id}>
															{p.name || p.id} ({cnt}m)
														</option>
													);
												})}
											</Select>
										</div>

										<div className="min-w-0">
											<Label htmlFor={`${prefix}_models_${i}`}>
												Models (multi-select)
											</Label>
											<ModelAdder
												id={`${prefix}_models_${i}`}
												options={availableModels}
												selected={s.models}
												disabled={!providerId}
												onAdd={(m) => updateStep(i, { models: [...s.models, m] })}
												onRemove={(m) =>
													updateStep(i, {
														models: s.models.filter((x) => x !== m),
													})
												}
											/>
											{!providerId ? (
												<p className="mt-1 text-[11px] text-muted-foreground">
													Pick a provider first to choose models.
												</p>
											) : null}
										</div>

										<div className="min-w-0">
											<Label htmlFor={`${prefix}_account_${i}`}>
												API Key Account (optional)
											</Label>
											<KeyAdder
												id={`${prefix}_account_${i}`}
												name={`${prefix}_account_${i}`}
												options={accountOpts.map((a) => a.label || `#${a.id}`)}
												value={s.accountText}
												onChange={(v) => updateStep(i, { accountText: v })}
												disabled={!providerId}
											/>
											<p className="mt-1 text-[11px] text-muted-foreground">
												{accountOpts.length === 0 && providerId
													? "No keys configured on this provider yet."
													: "Leave blank to rotate across all active keys."}
											</p>
										</div>
									</div>

									{showPrompt ? (
										<div>
											<Label htmlFor={`${prefix}_prompt_${i}`}>
												Stage instructions (optional)
											</Label>
											<Textarea
												id={`${prefix}_prompt_${i}`}
												name={`${prefix}_prompt_${i}`}
												rows={2}
												value={s.prompt}
												onChange={(e) => updateStep(i, { prompt: e.target.value })}
												placeholder={
													strategy === "pipeline"
														? "System prompt / transform instructions for this stage..."
														: "Optional system prompt override when this tier runs..."
												}
											/>
										</div>
									) : (
										<div className="pt-0.5">
											<input type="hidden" name={`${prefix}_prompt_${i}`} value="" />
											<button
												type="button"
												onClick={() =>
													setOpenPrompts((prev) => ({ ...prev, [i]: true }))
												}
												className="text-xs font-medium text-muted-foreground transition-colors hover:text-primary"
											>
												+ Add custom instructions for this tier
											</button>
										</div>
									)}
								</div>
							</div>

							{i < steps.length - 1 ? (
								<div className="flex items-center gap-2 py-2 pl-5">
									<div className="h-5 w-px bg-border-strong" />
									<span className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
										{connectorLabel}
									</span>
								</div>
							) : null}
						</div>
					);
				})}
			</div>

			<div className="pt-2">
				<Button type="button" variant="secondary" size="sm" onClick={addStep}>
					<Plus size={13} aria-hidden="true" />
					Add another {stepNoun.toLowerCase()}
				</Button>
			</div>

			<input type="hidden" name="step_count" value={steps.length} />
			{steps.map((s, i) =>
				s.models.map((m) => (
					<input
						key={`${i}-${m}`}
						type="hidden"
						name={`step_model_ids_${i}`}
						value={m}
					/>
				)),
			)}
		</div>
	);
}

function ModelAdder({
	id,
	options,
	selected,
	disabled,
	onAdd,
	onRemove,
}: {
	id?: string;
	options: string[];
	selected: string[];
	disabled?: boolean;
	onAdd: (m: string) => void;
	onRemove: (m: string) => void;
}) {
	const [text, setText] = useState("");
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [closing, setClosing] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const openRef = useRef(open);
	openRef.current = open;
	const closeTimerRef = useRef<number | null>(null);

	const q = text.trim().toLowerCase();
	const uid = useId();
	const filtered = options.filter(
		(o) => !selected.includes(o) && o.toLowerCase().includes(q),
	);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				closeDropdown();
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const closeDropdown = () => {
		if (!openRef.current) return;
		setClosing(true);
		if (closeTimerRef.current != null)
			window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			setOpen(false);
			setClosing(false);
		}, 100);
	};
	const openDropdown = () => {
		if (closeTimerRef.current != null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		setClosing(false);
		setOpen(true);
	};

	const commit = (model: string) => {
		if (model && !selected.includes(model)) {
			onAdd(model);
		}
		setText("");
		setHighlight(0);
		openDropdown();
	};

	if (disabled) {
		return (
			<Input id={id} value="" disabled placeholder="Select a provider first" />
		);
	}

	return (
		<div ref={rootRef} className="relative">
			<div className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground transition-colors hover:border-border-strong focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25">
				{selected.map((m) => (
					<span
						key={m}
						className="inline-flex shrink-0 items-center gap-1 rounded-md border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-medium text-foreground"
					>
						<span className="max-w-40 truncate font-mono">{m}</span>
						<button
							type="button"
							onClick={() => onRemove(m)}
							className="inline-flex items-center rounded p-px text-muted-foreground hover:text-foreground"
							aria-label={`Remove ${m}`}
						>
							<X size={12} />
						</button>
					</span>
				))}
				<input
					id={id}
					value={text}
					role="combobox"
					aria-expanded={open}
					aria-haspopup="listbox"
					aria-autocomplete="list"
					aria-activedescendant={
						open && filtered.length > 0
							? `${uid}-model-option-${highlight}`
							: undefined
					}
					placeholder={selected.length === 0 ? "Search models..." : ""}
					onFocus={openDropdown}
					onChange={(e) => {
						setText(e.target.value);
						openDropdown();
						setHighlight(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === ",") {
							e.preventDefault();
							if (open && filtered[highlight]) {
								commit(filtered[highlight]);
							} else if (text.trim()) {
								commit(text.trim());
							}
						} else if (
							e.key === "Backspace" &&
							text === "" &&
							selected.length > 0
						) {
							onRemove(selected[selected.length - 1]);
						} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							if (!open) {
								openDropdown();
								return;
							}
							e.preventDefault();
							setHighlight((h) =>
								e.key === "ArrowDown"
									? Math.min(h + 1, filtered.length - 1)
									: Math.max(h - 1, 0),
							);
						} else if (e.key === "Escape") {
							closeDropdown();
						}
					}}
					className="min-w-20 flex-1 bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
				/>
			</div>
			{open && filtered.length > 0 ? (
				<ul
					role="listbox"
					className={`slim-scroll absolute left-0 z-50 mt-1.5 max-h-52 w-full origin-top overflow-auto rounded-xl border border-border-strong bg-surface py-1 text-sm shadow-xl transition-[transform,opacity] duration-100 ${
						closing
							? "pointer-events-none scale-y-95 opacity-0"
							: "scale-y-100 opacity-100"
					}`}
				>
					{filtered.map((opt, i) => (
						<li
							key={opt}
							id={`${uid}-model-option-${i}`}
							role="option"
							aria-selected={i === highlight}
						>
							<button
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => commit(opt)}
								className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-glass-hover ${
									i === highlight ? "bg-glass-hover" : ""
								}`}
							>
								<span className="flex-1 truncate font-mono text-xs">{opt}</span>
								<span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-semibold uppercase text-primary">
									model
								</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

function KeyAdder({
	id,
	options,
	value,
	onChange,
	name,
	disabled,
}: {
	id?: string;
	options: string[];
	value: string;
	onChange: (v: string) => void;
	name: string;
	disabled?: boolean;
}) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [highlight, setHighlight] = useState(0);
	const [closing, setClosing] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);
	const openRef = useRef(open);
	openRef.current = open;
	const closeTimerRef = useRef<number | null>(null);

	const parts = value
		.split(",")
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && t.toLowerCase() !== "dynamic");

	const uid = useId();
	const q = query.trim().toLowerCase();
	const filtered = options.filter(
		(o) => !parts.includes(o) && o.toLowerCase().includes(q),
	);

	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				closeDropdown();
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const closeDropdown = () => {
		if (!openRef.current) return;
		setClosing(true);
		if (closeTimerRef.current != null)
			window.clearTimeout(closeTimerRef.current);
		closeTimerRef.current = window.setTimeout(() => {
			closeTimerRef.current = null;
			setOpen(false);
			setClosing(false);
		}, 100);
	};
	const openDropdown = () => {
		if (closeTimerRef.current != null) {
			window.clearTimeout(closeTimerRef.current);
			closeTimerRef.current = null;
		}
		setClosing(false);
		setOpen(true);
	};

	const commit = (item: string) => {
		if (item && !parts.includes(item)) {
			onChange([...parts, item].join(", "));
		}
		setQuery("");
		setHighlight(0);
		openDropdown();
	};

	if (disabled) {
		return (
			<Input id={id} value="" disabled placeholder="Select a provider first" />
		);
	}

	return (
		<div ref={rootRef} className="relative">
			<div className="flex min-h-9 w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1 text-sm text-foreground transition-colors hover:border-border-strong focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25">
				{parts.map((p) => (
					<span
						key={p}
						className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-foreground"
					>
						<span className="max-w-40 truncate">{p}</span>
						<button
							type="button"
							onClick={() => onChange(parts.filter((x) => x !== p).join(", "))}
							className="inline-flex items-center rounded p-px text-muted-foreground hover:text-foreground"
							aria-label={`Remove ${p}`}
						>
							<X size={12} />
						</button>
					</span>
				))}
				<input
					id={id}
					value={query}
					role="combobox"
					aria-expanded={open}
					aria-haspopup="listbox"
					aria-autocomplete="list"
					aria-activedescendant={
						open && filtered.length > 0 ? `${uid}-key-option-${highlight}` : undefined
					}
					placeholder={
						parts.length === 0 ? "All active keys" : ""
					}
					onFocus={openDropdown}
					onChange={(e) => {
						setQuery(e.target.value);
						openDropdown();
						setHighlight(0);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === ",") {
							e.preventDefault();
							if (open && filtered[highlight]) {
								commit(filtered[highlight]);
							} else if (query.trim()) {
								commit(query.trim());
							}
						} else if (
							e.key === "Backspace" &&
							query === "" &&
							parts.length > 0
						) {
							onChange(parts.slice(0, -1).join(", "));
						} else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							if (!open) {
								openDropdown();
								return;
							}
							e.preventDefault();
							setHighlight((h) =>
								e.key === "ArrowDown"
									? Math.min(h + 1, filtered.length - 1)
									: Math.max(h - 1, 0),
							);
						} else if (e.key === "Escape") {
							closeDropdown();
						}
					}}
					className="min-w-20 flex-1 bg-transparent py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
				/>
			</div>
			{open && filtered.length > 0 ? (
				<ul
					role="listbox"
					className={`slim-scroll absolute left-0 z-50 mt-1.5 max-h-52 w-full origin-top overflow-auto rounded-xl border border-border-strong bg-surface py-1 text-sm shadow-xl transition-[transform,opacity] duration-100 ${
						closing
							? "pointer-events-none scale-y-95 opacity-0"
							: "scale-y-100 opacity-100"
					}`}
				>
					{filtered.map((opt, i) => (
						<li
							key={opt}
							id={`${uid}-key-option-${i}`}
							role="option"
							aria-selected={i === highlight}
						>
							<button
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => commit(opt)}
								className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground hover:bg-glass-hover ${
									i === highlight ? "bg-glass-hover" : ""
								}`}
							>
								<span className="flex-1 truncate text-xs">{opt}</span>
								<span className="rounded bg-primary/15 px-1.5 py-0.5 text-xs font-semibold uppercase text-primary">
									account
								</span>
							</button>
						</li>
					))}
				</ul>
			) : null}
			<input type="hidden" name={name} value={value || "dynamic"} />
		</div>
	);
}
function ComboForm({
	mode,
	combo,
	initialPoolId,
	providers,
	modelRows,
	accounts,
	pools,
	onCancel,
}: {
	mode: "create" | "update";
	combo?: {
		id: number;
		name: string;
		strategy: string;
		steps: ComboStep[];
	};
	initialPoolId?: number | null;
	providers: ProviderOption[];
	modelRows: ModelOption[];
	accounts: AccountOption[];
	pools: PoolOption[];
	onCancel: () => void;
}) {
	const [name, setName] = useState(combo?.name ?? "");
	const [strategy, setStrategy] = useState<"priority" | "pipeline">(
		combo?.strategy === "pipeline" ? "pipeline" : "priority",
	);
	const cleanPreview = name.trim() || "my-combo";

	return (
		<Form method="post" className="space-y-5">
			<input type="hidden" name="section" value={mode} />
			{combo ? <input type="hidden" name="id" value={combo.id} /> : null}
			<input type="hidden" name="strategy" value={strategy} />

			{/* Section 1: Name & Proxy Pool */}
			<div className="grid gap-4 md:grid-cols-2">
				<div>
					<Label htmlFor={`${mode}-combo-name`}>Combo Name</Label>
					<Input
						id={`${mode}-combo-name`}
						name="name"
						required
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="e.g. coding-fallback"
						className="font-mono"
					/>
					<p className="mt-1.5 text-xs text-muted-foreground">
						Clients call this combo with model{" "}
						<code className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-foreground">
							combo:{cleanPreview}
						</code>
					</p>
				</div>
				<div>
					<Label htmlFor={`${mode}-combo-pool`}>Outbound Proxy Pool (optional)</Label>
					<Select
						id={`${mode}-combo-pool`}
						name="proxy_pool_id"
						defaultValue={initialPoolId != null ? String(initialPoolId) : ""}
					>
						<option value="">Default (use provider or global pool)</option>
						{pools.map((p) => (
							<option key={p.id} value={String(p.id)}>
								{p.name}
							</option>
						))}
					</Select>
					<p className="mt-1.5 text-xs text-muted-foreground">
						Used only when neither client key nor account has a dedicated pool.
					</p>
				</div>
			</div>

			{/* Section 2: Unambiguous Strategy Selector */}
			<div>
				<p className="mb-2 text-xs font-medium text-muted-foreground">
					Execution Mode
				</p>
				<div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="Execution mode">
					<button
						type="button"
						role="radio"
						aria-checked={strategy === "priority"}
						onClick={() => setStrategy("priority")}
						className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${
							strategy === "priority"
								? "border-primary bg-primary/10"
								: "border-border bg-surface-2/40 hover:border-border-strong"
						}`}
					>
						<span
							className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${
								strategy === "priority"
									? "border-primary/40 bg-primary/15 text-primary"
									: "border-border bg-surface text-muted-foreground"
							}`}
						>
							<Shield size={15} aria-hidden="true" />
						</span>
						<div className="min-w-0">
							<p className="text-sm font-semibold text-foreground">
								Priority Fallback
							</p>
							<p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
								Try Tier 1 first. Automatically fall back to Tier 2, 3, etc. on error or rate limit.
							</p>
						</div>
					</button>

					<button
						type="button"
						role="radio"
						aria-checked={strategy === "pipeline"}
						onClick={() => setStrategy("pipeline")}
						className={`flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors ${
							strategy === "pipeline"
								? "border-primary bg-primary/10"
								: "border-border bg-surface-2/40 hover:border-border-strong"
						}`}
					>
						<span
							className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${
								strategy === "pipeline"
									? "border-primary/40 bg-primary/15 text-primary"
									: "border-border bg-surface text-muted-foreground"
							}`}
						>
							<Layers size={15} aria-hidden="true" />
						</span>
						<div className="min-w-0">
							<p className="text-sm font-semibold text-foreground">
								Sequential Pipeline
							</p>
							<p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
								Run Stage 1, then feed its output into Stage 2 in sequence (e.g. draft then refine).
							</p>
						</div>
					</button>
				</div>
			</div>

			{/* Section 3: Visual Step Builder */}
			<StepEditor
				prefix="step"
				strategy={strategy}
				initialSteps={combo?.steps}
				providers={providers}
				modelRows={modelRows}
				accounts={accounts}
			/>

			<div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
				<Button type="button" variant="outline" onClick={onCancel}>
					Cancel
				</Button>
				<Button type="submit" variant="primary">
					{mode === "create" ? "Create Combo" : "Save Changes"}
				</Button>
			</div>
		</Form>
	);
}

export default function Combo({ loaderData }: Route.ComponentProps) {
	const { combos, providers, modelRows, accounts, pools } = loaderData;
	const msg = useActionData<ActionMsg>();
	const submit = useSubmit();
	const { toast } = useToast();
	const [editingId, setEditingId] = useState<number | null>(null);
	const [showAdd, setShowAdd] = useState(false);
	const lastMsgRef = useRef<ActionMsg | null>(null);
	useEffect(() => {
		if (!msg || lastMsgRef.current === msg) return;
		lastMsgRef.current = msg;
		if (msg.deleted) {
			toast({ title: msg.deleted, variant: "success" });
		} else if (msg.saved) {
			setShowAdd(false);
			setEditingId(null);
			toast({ title: msg.saved, variant: "success" });
		} else if (msg.error) {
			toast({ title: "Save combo failed", description: msg.error, variant: "error" });
		}
	}, [msg, toast]);
	const { dialog, confirm } = useConfirm();
	const poolName = (id: number | null | undefined): string | null => {
		if (id == null) return null;
		return pools.find((p) => p.id === id)?.name ?? `#${id}`;
	};
	const comboPoolIdOf = (c: (typeof combos)[number]): number | null => {
		const raw = (c.config as Record<string, unknown> | null | undefined)?.[
			"proxy_pool_id"
		];
		const n =
			typeof raw === "string" && raw.trim() !== ""
				? Number(raw.trim())
				: Number(raw);
		return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
	};

	return (
		<div>
			<PageHeader
				title="Model Combos"
				icon={<GitBranch size={20} />}
				subtitle="Bundle models behind combo:<name> for automatic fallback or sequential pipelines."
				actions={
					<Button
						type="button"
						variant={showAdd ? "outline" : "primary"}
						onClick={() => {
							setEditingId(null);
							setShowAdd((s) => !s);
						}}
					>
						{showAdd ? <X size={15} aria-hidden="true" /> : <Plus size={15} aria-hidden="true" />}
						{showAdd ? "Close Form" : "New Combo"}
					</Button>
				}
			/>

			{msg?.error ? (
				<div
					role="alert"
					className="mb-4 rounded-xl border border-danger/35 bg-danger/10 px-4 py-3 text-sm text-danger"
				>
					{msg.error}
				</div>
			) : null}

			{showAdd ? (
				<Card className="mb-6">
					<div className="mb-4 flex items-center justify-between gap-2 border-b border-border pb-3">
						<div>
							<h2 className="text-base font-semibold text-foreground">
								Create Model Combo
							</h2>
							<p className="text-xs text-muted-foreground">
								Define a synthetic model name, choose an execution mode, and order your steps.
							</p>
						</div>
					</div>
					<ComboForm
						mode="create"
						providers={providers}
						modelRows={modelRows}
						accounts={accounts}
						pools={pools}
						onCancel={() => setShowAdd(false)}
					/>
				</Card>
			) : null}

			{combos.length === 0 && !showAdd ? (
				<Card>
					<EmptyState
						icon={<Link2 size={22} />}
						title="No model combos yet"
						description="Create a Priority Fallback chain to survive provider rate limits, or a Sequential Pipeline to chain multiple models together."
						action={
							<Button type="button" onClick={() => setShowAdd(true)}>
								<Plus size={14} aria-hidden="true" />
								Create your first combo
							</Button>
						}
					/>
				</Card>
			) : combos.length > 0 ? (
				<div className="space-y-4">
					{combos.map((c) => {
						const isPipeline = c.strategy === "pipeline";
						const modelCount = c.steps.reduce((n, s) => n + s.modelIds.length, 0);
						const poolId = comboPoolIdOf(c);
						const isEditing = editingId === c.id;
						const modelTag = `combo:${c.name}`;

						return (
							<Card key={c.id} padded={false} className="overflow-visible">
								<div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-2/40 px-4 py-3.5 sm:px-5">
									<div className="flex min-w-0 flex-wrap items-center gap-2.5">
										<code className="rounded-md border border-border bg-surface px-2.5 py-1 font-mono text-sm font-semibold text-foreground">
											{modelTag}
										</code>
										<CopyButton text={modelTag} label={`Copy ${modelTag}`} />
										<Badge tone={isPipeline ? "primary" : "info"}>
											{isPipeline ? "Sequential pipeline" : "Priority fallback"}
										</Badge>
										<Badge tone="neutral">
											{c.steps.length} {c.steps.length === 1 ? "step" : "steps"} · {modelCount}{" "}
											{modelCount === 1 ? "model" : "models"}
										</Badge>
										{poolId != null ? (
											<Badge tone="neutral">proxy: {poolName(poolId)}</Badge>
										) : null}
									</div>

									<div className="flex shrink-0 items-center gap-2">
										<Button
											type="button"
											size="sm"
											variant="outline"
											onClick={() => {
												setShowAdd(false);
												setEditingId(isEditing ? null : c.id);
											}}
										>
											{isEditing ? (
												<>
													<X size={13} aria-hidden="true" /> Close
												</>
											) : (
												<>
													<Pencil size={13} aria-hidden="true" /> Edit
												</>
											)}
										</Button>
										<Form
											method="post"
											onSubmit={(e) => {
												e.preventDefault();
												const form = e.currentTarget;
												void confirm({
													title: "Delete combo?",
													description: `${modelTag} will be permanently removed.`,
													confirmLabel: "Delete",
													variant: "danger",
												}).then((ok) => {
													if (ok) submit(form);
												});
											}}
										>
											<input type="hidden" name="section" value="delete" />
											<input type="hidden" name="id" value={c.id} />
											<Button type="submit" size="sm" variant="danger">
												<Trash2 size={13} aria-hidden="true" /> Delete
											</Button>
										</Form>
									</div>
								</div>

								<div className="p-4 sm:p-5">
									{isEditing ? (
										<ComboForm
											mode="update"
											combo={c}
											initialPoolId={poolId}
											providers={providers}
											modelRows={modelRows}
											accounts={accounts}
											pools={pools}
											onCancel={() => setEditingId(null)}
										/>
									) : (
										<div className="space-y-0">
											{c.steps.map((s, i) => {
												const accs = accountsForProvider(
													accounts,
													s.providerId ?? "",
												);
												const accountLabel =
													s.accountIds.length === 0
														? "All active keys"
														: s.accountIds
																.map(
																	(aid) =>
																		accs.find((a) => a.id === aid)?.label ??
																		`#${aid}`,
																)
																.join(", ");

												return (
													<div key={s.id}>
														<div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-surface-2/35 px-3.5 py-2.5 text-xs">
															<span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-primary/15 font-mono text-[11px] font-semibold text-primary">
																{i + 1}
															</span>
															<Badge tone="info">{s.providerId || "any"}</Badge>
															<div className="flex flex-wrap items-center gap-1.5">
																{s.modelIds.map((mid) => (
																	<code
																		key={mid}
																		className="rounded border border-border bg-surface px-2 py-0.5 font-mono text-xs text-foreground"
																	>
																		{mid}
																	</code>
																))}
															</div>
															<span className="ml-auto flex items-center gap-1.5 text-muted-foreground">
																<UserRound size={12} aria-hidden="true" />
																<span>{accountLabel}</span>
															</span>
															{s.prompt ? (
																<p
																	className="w-full border-t border-border/50 pt-1.5 text-xs italic text-muted-foreground"
																	title={s.prompt}
																>
																	&ldquo;{s.prompt}&rdquo;
																</p>
															) : null}
														</div>
														{i < c.steps.length - 1 ? (
															<div className="flex items-center gap-2 py-1.5 pl-6">
																<div className="h-4 w-px bg-border-strong" />
																<span className="text-[11px] font-medium text-muted-foreground">
																	{isPipeline ? "feeds into stage" : "fallback to tier"} {i + 2}
																</span>
															</div>
														) : null}
													</div>
												);
											})}
										</div>
									)}
								</div>
							</Card>
						);
					})}
				</div>
			) : null}

			{dialog}
		</div>
	);
}

import { PROVIDER_REGISTRY } from "~/registry";
import type { RegistryEntry } from "~/types";
import { Badge, type BadgeTone } from "./ui/badge";

export type ProviderTemplate = {
  id: string;
  name: string;
  base_url: string;
  auth_type: "none" | "apikey" | "bearer" | "oauth";
  description: string;
  color: string;
};

const COMPATIBLE_IDS = new Set<string>(["openai", "anthropic"]);

const COMPATIBLE_NAME: Record<string, string> = {
  openai: "OpenAI Compatible",
  anthropic: "Anthropic Compatible",
};

const CUSTOM_TEMPLATE: ProviderTemplate = {
  id: "custom",
  name: "Custom Provider",
  base_url: "https://api.example.com/v1",
  auth_type: "bearer",
  description:
    "Configure any OpenAI-compatible, self-hosted, or custom inference endpoint manually.",
  color: "bg-slate-600",
};

export const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  ...PROVIDER_REGISTRY.filter((entry: RegistryEntry) =>
    COMPATIBLE_IDS.has(entry.id),
  ).map((entry: RegistryEntry) => ({
    id: entry.id,
    name: COMPATIBLE_NAME[entry.id] ?? entry.alias,
    base_url: entry.baseUrl,
    auth_type: entry.authType,
    description: entry.description ?? "AI provider without a description",
    color: entry.color ?? "bg-primary",
  })),
  CUSTOM_TEMPLATE,
];

const AUTH_LABELS: Record<ProviderTemplate["auth_type"], string> = {
  none: "No auth",
  bearer: "Bearer",
  apikey: "API key",
  oauth: "OAuth",
};

const AUTH_TONE: Record<ProviderTemplate["auth_type"], BadgeTone> = {
  none: "neutral",
  bearer: "info",
  apikey: "primary",
  oauth: "neutral",
};

type CardProps = {
  template: ProviderTemplate;
  onPick: (t: ProviderTemplate) => void;
  active?: boolean;
};

export function ProviderTemplateCard({ template, onPick, active }: CardProps) {
  return (
    <button
      type="button"
      onClick={() => onPick(template)}
      className={`group flex cursor-pointer flex-col justify-between rounded-lg border bg-surface p-4 text-left transition-colors hover:border-border-strong hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
        active ? "border-primary ring-2 ring-primary/20" : "border-border"
      }`}
    >
      <div className="min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="truncate font-semibold text-foreground">{template.name}</p>
          <Badge tone={AUTH_TONE[template.auth_type]}>{AUTH_LABELS[template.auth_type]}</Badge>
        </div>
        <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
          {template.description}
        </p>
      </div>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-border/70 pt-3">
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {template.base_url}
        </span>
        <span className="shrink-0 text-xs font-medium text-primary">
          {template.id === "custom" ? "Configure" : "Use preset"}
        </span>
      </div>
    </button>
  );
}

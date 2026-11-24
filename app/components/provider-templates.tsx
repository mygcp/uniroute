import { ArrowRight } from "lucide-react";
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
      className={`glass-panel glass-panel-interactive group flex cursor-pointer flex-col justify-between p-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
        active ? "border-primary ring-2 ring-primary/25" : ""
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold text-white shadow-sm ${template.color}`}
        >
          {template.name.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-foreground">{template.name}</p>
          <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
            {template.description}
          </p>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3">
        <Badge tone={AUTH_TONE[template.auth_type]}>{AUTH_LABELS[template.auth_type]}</Badge>
        <span className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-transform group-hover:translate-x-0.5">
          {template.id === "custom" ? "Configure manually" : "Use template"}
          <ArrowRight size={13} />
        </span>
      </div>
    </button>
  );
}

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

const COMPATIBLE_ID = "openai" satisfies RegistryEntry["id"];
const COMPATIBLE_IDS = new Set<string>([COMPATIBLE_ID, "anthropic"]);

const COMPATIBLE_NAME: Record<string, string> = {
  openai: "OpenAI Compatible",
  anthropic: "Anthropic Compatible",
};

export const PROVIDER_TEMPLATES: ProviderTemplate[] = PROVIDER_REGISTRY.filter(
  (entry: RegistryEntry) => COMPATIBLE_IDS.has(entry.id),
).map((entry: RegistryEntry) => ({
  id: entry.id,
  name: COMPATIBLE_NAME[entry.id] ?? entry.alias,
  base_url: entry.baseUrl,
  auth_type: entry.authType,
  description: entry.description ?? "AI provider without a description",
  color: entry.color ?? "bg-muted",
}));

const AUTH_LABELS: Record<ProviderTemplate["auth_type"], string> = {
  none: "no auth",
  bearer: "bearer",
  apikey: "api key",
  oauth: "oauth",
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
      className={`group rounded-xl border p-4 text-left shadow-sm transition-all hover:shadow-md ${
        active
          ? "border-primary ring-2 ring-primary/20"
          : "border-border bg-surface hover:border-primary/50"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white ${template.color}`}
        >
          {template.name.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-foreground">{template.name}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <Badge tone={AUTH_TONE[template.auth_type]}>{AUTH_LABELS[template.auth_type]}</Badge>
        <span className="text-xs font-medium text-primary group-hover:underline">
          {template.id === "custom" ? "Manual" : "Use"}
        </span>
      </div>
    </button>
  );
}
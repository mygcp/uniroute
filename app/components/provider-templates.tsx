import { PROVIDER_REGISTRY } from "~/registry";
import type { RegistryEntry } from "~/types";

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
  description: entry.description ?? "Provider AI tanpa deskripsi",
  color: entry.color ?? "bg-gray-500",
}));

const AUTH_LABELS: Record<ProviderTemplate["auth_type"], string> = {
  none: "no auth",
  bearer: "bearer",
  apikey: "api key",
  oauth: "oauth",
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
        active ? "border-blue-500 ring-2 ring-blue-200 dark:ring-blue-900"
        : "border-gray-200 bg-white hover:border-blue-300 dark:border-gray-800 dark:bg-gray-900 dark:hover:border-blue-700"
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-sm font-bold text-white ${template.color}`}
        >
          {template.name.slice(0, 1)}
        </span>
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 dark:text-white">{template.name}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{template.description}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <span className="rounded bg-gray-100 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {AUTH_LABELS[template.auth_type]}
        </span>
        <span className="text-xs font-medium text-blue-600 group-hover:underline dark:text-blue-400">
          {template.id === "custom" ? "Isi manual" : "Gunakan"}
        </span>
      </div>
    </button>
  );
}

import { Form, Link, useNavigation } from "react-router";
import type { ProviderTemplate } from "./provider-templates";
import { Card } from "./ui/card";
import { Button, buttonClass } from "./ui/button";
import { Checkbox, Input, Label, Select } from "./ui/field";
import { Spinner } from "./ui/feedback";

type Props = {
  provider?: {
    id: string;
    name: string;
    base_url: string;
    auth_type: string;
    is_active: number | boolean;
    weight: number;
    priority: number;
    prefix?: string | null;
  };
  template?: ProviderTemplate | null;
  providers: string[];
  onCancel?: () => void;
};

function suggestUniqueId(base: string, existing: string[]): string {
  if (!base || base === "custom") return "";
  const set = new Set(existing);
  if (!set.has(base)) return base;
  let n = 2;
  while (set.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function ProviderForm({ provider, template, providers, onCancel }: Props) {
  const isEdit = !!provider;
  const t = template ?? null;
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";

  const defaultId = isEdit
    ? provider!.id
    : suggestUniqueId(t?.id ?? "", providers);
  const defaultName = isEdit
    ? provider!.name
    : t && t.id !== "custom"
      ? t.name
      : "";
  const defaultBaseUrl = isEdit
    ? provider!.base_url
    : t && t.id !== "custom"
      ? t.base_url
      : "";

  return (
    <Card>
      <Form method="post">
        <input type="hidden" name="intent" value={isEdit ? "update" : "create"} />
        {isEdit ? <input type="hidden" name="id" value={provider!.id} /> : null}
        {!isEdit && t && t.id !== "custom" ? (
          <input type="hidden" name="template_id" value={t.id} />
        ) : null}
        {t ? (
          <p className="mb-4 rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-xs text-muted-foreground">
            Template: <span className="font-semibold text-foreground">{t.name}</span>. Review or customize the fields below before saving.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="pid">Provider ID</Label>
            <Input
              id="pid"
              name="id"
              defaultValue={defaultId}
              required
              placeholder="e.g. openai, my-vllm"
              disabled={isEdit}
              className="font-mono"
            />
          </div>
          <div>
            <Label htmlFor="pname">Display Name</Label>
            <Input
              id="pname"
              name="name"
              defaultValue={defaultName}
              required
              placeholder="e.g. OpenAI Production"
            />
          </div>
          <div>
            <Label htmlFor="pbase">Base URL</Label>
            <Input
              id="pbase"
              name="base_url"
              defaultValue={defaultBaseUrl}
              required
              placeholder="https://api.openai.com/v1"
              className="font-mono"
            />
          </div>
          <div>
            <Label htmlFor="pauth">Auth Type</Label>
            <Select
              id="pauth"
              name="auth_type"
              defaultValue={t?.auth_type ?? provider?.auth_type ?? "bearer"}
            >
              <option value="bearer">Bearer token</option>
              <option value="apikey">API key header</option>
              <option value="none">No auth</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="pweight">Weight</Label>
            <Input
              id="pweight"
              name="weight"
              type="number"
              defaultValue={provider?.weight ?? 1}
              min={0}
            />
          </div>
          <div>
            <Label htmlFor="ppriority">Priority</Label>
            <Input
              id="ppriority"
              name="priority"
              type="number"
              defaultValue={provider?.priority ?? 0}
              min={0}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="pprefix">Model Prefix (optional)</Label>
            <Input
              id="pprefix"
              name="prefix"
              defaultValue={provider?.prefix?.replace(/\/+$/g, "") ?? ""}
              placeholder="e.g. openai (leave blank for no prefix)"
              pattern="[a-zA-Z0-9._\-]{1,32}"
              title='Enter prefix name only without "/" (e.g. openai)'
              className="font-mono"
            />
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
              Virtual UniRoute namespace. Enter the name only;{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px]">/</code>{" "}
              is added automatically so models appear as{" "}
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px]">
                prefix/model-name
              </code>
              . Leave blank to expose upstream model names directly.
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Checkbox
            id="pactive"
            name="is_active"
            value="1"
            defaultChecked={provider ? Boolean(provider.is_active) : true}
          />
          <Label htmlFor="pactive" className="mb-0 cursor-pointer text-sm text-foreground">
            Active (accept traffic immediately)
          </Label>
        </div>
        <div className="mt-5 flex flex-wrap gap-2 border-t border-border pt-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? <Spinner size={14} /> : null}
            {isEdit ? "Save Changes" : "Create Provider"}
          </Button>
          {onCancel ? (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          ) : isEdit || t ? (
            <Link to="/providers" className={buttonClass("outline", "md")}>
              Cancel
            </Link>
          ) : null}
        </div>
      </Form>
    </Card>
  );
}

import { Form } from "react-router";
import type { ProviderTemplate } from "./provider-templates";
import { Card } from "./ui/card";
import { Button } from "./ui/button";
import { Checkbox, Input, Label, Select } from "./ui/field";

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
};

export function ProviderForm({ provider, template }: Props) {
  const isEdit = !!provider;
  const t = template ?? null;
  return (
    <Card>
      <Form method="post">
        <input type="hidden" name="intent" value={isEdit ? "update" : "create"} />
        {isEdit ? <input type="hidden" name="id" value={provider!.id} /> : null}
        {!isEdit && t ? <input type="hidden" name="template_id" value={t.id} /> : null}
        {t ? (
          <p className="mb-4 text-xs text-muted-foreground">
            Template: <span className="font-medium text-foreground">{t.name}</span> — edit the
            fields below if needed before saving.
          </p>
        ) : null}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="pid">ID / Name</Label>
            <Input
              id="pid"
              name="id"
              defaultValue={t?.id ?? provider?.id ?? ""}
              required
              placeholder="openai"
              disabled={isEdit}
            />
          </div>
          <div>
            <Label htmlFor="pname">Display Name</Label>
            <Input
              id="pname"
              name="name"
              defaultValue={t?.name ?? provider?.name ?? ""}
              required
            />
          </div>
          <div>
            <Label htmlFor="pbase">Base URL</Label>
            <Input
              id="pbase"
              name="base_url"
              defaultValue={t?.base_url ?? provider?.base_url ?? ""}
              required
            />
          </div>
          <div>
            <Label htmlFor="pauth">Auth Type</Label>
            <Select
              id="pauth"
              name="auth_type"
              defaultValue={t?.auth_type ?? provider?.auth_type ?? "bearer"}
            >
              <option value="none">none</option>
              <option value="bearer">bearer</option>
              <option value="apikey">apikey</option>
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
          <div>
            <Label htmlFor="pprefix">Prefix (opsional)</Label>
            <Input
              id="pprefix"
              name="prefix"
              defaultValue={provider?.prefix?.replace(/\/+$/g, "") ?? ""}
              placeholder="openai — kosong = tanpa prefix"
              pattern="[a-zA-Z0-9._\-]{1,32}"
              title='Prefix cukup nama saja tanpa "/" (contoh: openai)'
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Prefix virtual, hanya di UniRoute. Cukup nama saja —{" "}
              <span className="font-mono">/</span> otomatis sebagai pemisah, model
              tampil sebagai <span className="font-mono">prefix/nama_model</span>{" "}
              (mis. <span className="font-mono">openai/gpt-4o</span>). Bila nama
              model bawaan sudah mengandung <span className="font-mono">/</span>{" "}
              (mis. <span className="font-mono">oc/muse1.3</span>) tidak masalah —
              tinggal ditempel jadi{" "}
              <span className="font-mono">oc/oc/muse1.3</span>. Kosongkan untuk
              tanpa prefix.
            </p>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Checkbox
            id="pactive"
            name="is_active"
            value="1"
            defaultChecked={provider ? Boolean(provider.is_active) : false}
          />
          <Label htmlFor="pactive" className="mb-0">
            Active
          </Label>
        </div>
        <div className="mt-4 flex gap-2">
          <Button type="submit">{isEdit ? "Save Changes" : "Create Provider"}</Button>
          {isEdit || t ? (
            <a
              href="/providers"
              className="inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              Cancel
            </a>
          ) : null}
        </div>
      </Form>
    </Card>
  );
}
import { Form } from "react-router";
import type { ProviderTemplate } from "./provider-templates";

type Props = {
  provider?: {
    id: string;
    name: string;
    base_url: string;
    auth_type: string;
    is_active: number | boolean;
    weight: number;
    priority: number;
  };
  template?: ProviderTemplate | null;
  providers: string[];
};

export function ProviderForm({ provider, template }: Props) {
  const isEdit = !!provider;
  const t = template ?? null;
  return (
    <Form method="post" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <input type="hidden" name="intent" value={isEdit ? "update" : "create"} />
      {isEdit ? <input type="hidden" name="id" value={provider!.id} /> : null}
      {!isEdit && t ? <input type="hidden" name="template_id" value={t.id} /> : null}
      {t ? (
        <p className="mb-4 text-xs text-gray-500 dark:text-gray-400">
          Template: <span className="font-medium text-gray-700 dark:text-gray-200">{t.name}</span> — ubah
          field di bawah bila perlu sebelum menyimpan.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">ID / Name</label>
          <input
            name="id"
            defaultValue={t?.id ?? provider?.id ?? ""}
            required
            placeholder="openai"
            disabled={isEdit}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white disabled:bg-gray-50 dark:disabled:bg-gray-800"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Display Name</label>
          <input
            name="name"
            defaultValue={t?.name ?? provider?.name ?? ""}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Base URL</label>
          <input
            name="base_url"
            defaultValue={t?.base_url ?? provider?.base_url ?? ""}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Auth Type</label>
          <select
            name="auth_type"
            defaultValue={t?.auth_type ?? provider?.auth_type ?? "bearer"}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          >
            <option value="none">none</option>
            <option value="bearer">bearer</option>
            <option value="apikey">apikey</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Weight</label>
          <input
            name="weight"
            type="number"
            defaultValue={provider?.weight ?? 1}
            min={0}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">Priority</label>
          <input
            name="priority"
            type="number"
            defaultValue={provider?.priority ?? 0}
            min={0}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
        <input
          name="is_active"
          type="checkbox"
          defaultChecked={provider ? Boolean(provider.is_active) : false}
          value="1"
          className="h-4 w-4 rounded border-gray-300"
        />
        Active
      </label>
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {isEdit ? "Save Changes" : "Create Provider"}
        </button>
        {isEdit || t ? (
          <a
            href="/providers"
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            Cancel
          </a>
        ) : null}
      </div>
    </Form>
  );
}
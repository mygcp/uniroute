import { Form } from "react-router";

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
  providers: string[];
};

export function ProviderForm({ provider }: Props) {
  const isEdit = !!provider;
  return (
    <Form method="post" className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
      <input type="hidden" name="intent" value={isEdit ? "update" : "create"} />
      {isEdit ? <input type="hidden" name="id" value={provider!.id} /> : null}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">ID / Name</label>
          <input
            name="id"
            defaultValue={provider?.id ?? ""}
            required
            placeholder="openai"
            disabled={isEdit}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Display Name</label>
          <input
            name="name"
            defaultValue={provider?.name ?? ""}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Base URL</label>
          <input
            name="base_url"
            defaultValue={provider?.base_url ?? ""}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Auth Type</label>
          <select
            name="auth_type"
            defaultValue={provider?.auth_type ?? "bearer"}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          >
            <option value="none">none</option>
            <option value="bearer">bearer</option>
            <option value="apikey">apikey</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Weight</label>
          <input
            name="weight"
            type="number"
            defaultValue={provider?.weight ?? 1}
            min={0}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Priority</label>
          <input
            name="priority"
            type="number"
            defaultValue={provider?.priority ?? 0}
            min={0}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
          />
        </div>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm text-gray-700">
        <input
          name="is_active"
          type="checkbox"
          defaultChecked={provider ? Boolean(provider.is_active) : true}
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
        {isEdit ? (
          <a href="/providers" className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50">
            Cancel
          </a>
        ) : null}
      </div>
    </Form>
  );
}
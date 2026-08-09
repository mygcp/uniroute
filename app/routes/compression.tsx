import { Form } from "react-router";
import type { Route } from "./+types/compression";
import { FileArchive } from "lucide-react";
import { getSettings } from "../.server/compressor";
import { query } from "../.server/db";
import { testCompression } from "../.server/compressor";

export function loader() {
  return { settings: getSettings() };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "test") {
    const sample = String(form.get("sample") ?? "Contoh prompt untuk test kompresi.");
    const rtkPath = String(form.get("rtk_binary_path") || "./bin/rtk");
    const cavemanPath = String(form.get("caveman_binary_path") || "./bin/caveman");
    const result = await testCompression(sample);
    return { ...result, pending: false, sample };
  }

  const rtkEnabled = form.get("rtk_enabled") === "1" ? 1 : 0;
  const cavemanEnabled = form.get("caveman_enabled") === "1" ? 1 : 0;
  const rtkPath = String(form.get("rtk_binary_path") || "./bin/rtk");
  const cavemanPath = String(form.get("caveman_binary_path") || "./bin/caveman");

  query(
    `INSERT INTO compression_settings
       (id, rtk_enabled, caveman_enabled, rtk_binary_path, caveman_binary_path, updated_at)
     VALUES (1, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       rtk_enabled = ?, caveman_enabled = ?, rtk_binary_path = ?, caveman_binary_path = ?, updated_at = unixepoch()`,
  ).run(
    rtkEnabled,
    cavemanEnabled,
    rtkPath,
    cavemanPath,
    rtkEnabled,
    cavemanEnabled,
    rtkPath,
    cavemanPath,
  );
  return { saved: true };
}

export default function Compression({ loaderData, actionData }: Route.ComponentProps) {
  const { settings } = loaderData;
  const test = actionData && "pending" in actionData ? actionData : null;
  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <FileArchive size={24} /> Compression
      </h1>

      <div className="mb-8 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-1 text-sm font-semibold text-gray-600 dark:text-gray-300">Settings</h2>
        <Form method="post" className="mt-4 space-y-4">
          <input type="hidden" name="intent" value="save" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-gray-100 p-4 dark:border-gray-800">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                <input
                  type="checkbox"
                  name="rtk_enabled"
                  value="1"
                  defaultChecked={settings.rtk_enabled}
                  className="h-4 w-4"
                />
                RTK enabled
              </label>
              <input
                name="rtk_binary_path"
                defaultValue={settings.rtk_binary_path}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
            <div className="space-y-4 rounded-lg border border-gray-100 p-4 dark:border-gray-800">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-300">
                <input
                  type="checkbox"
                  name="caveman_enabled"
                  value="1"
                  defaultChecked={settings.caveman_enabled}
                  className="h-4 w-4"
                />
                Caveman enabled
              </label>
              <input
                name="caveman_binary_path"
                defaultValue={settings.caveman_binary_path}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
              />
            </div>
          </div>
          {actionData && "saved" in actionData ? (
            <p className="text-sm text-green-600 dark:text-green-400">Settings tersimpan.</p>
          ) : null}
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Save settings
          </button>
        </Form>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="text-sm font-semibold text-gray-600 dark:text-gray-300">Test kompresi</h2>
        <Form method="post" className="mt-4">
          <input type="hidden" name="intent" value="test" />
          <textarea
            name="sample"
            rows={3}
            defaultValue="Contoh prompt test kompresi RTK & Caveman."
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
          <button
            type="submit"
            className="mt-3 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 dark:bg-gray-700 dark:hover:bg-gray-600"
          >
            Run test
          </button>
        </Form>
        {test ? (
          <pre className="mt-4 rounded-lg bg-gray-50 p-4 text-xs text-gray-800 dark:bg-gray-800 dark:text-gray-200">
            {JSON.stringify(
              {
                output: test.output,
                usedFallback: test.usedFallback,
                durationMs: test.durationMs,
              },
              null,
              2,
            )}
          </pre>
        ) : null}
      </div>
    </div>
  );
}
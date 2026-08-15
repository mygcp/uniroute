import { Form } from "react-router";
import type { Route } from "./+types/compression";
import { FileArchive } from "lucide-react";
import { getSettings, testCompression } from "../.server/compressor";
import { query } from "../.server/db";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Checkbox, Input, Label, Textarea } from "../components/ui/field";

export function loader() {
  return { settings: getSettings() };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "test") {
    const sample = String(
      form.get("sample") ?? "Example prompt for compression test (RTK & Caveman).",
    );
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
      <PageHeader
        title="Compression"
        icon={<FileArchive size={24} />}
        subtitle="Configure and test prompt compression."
      />

      <Card className="mb-8">
        <h2 className="mb-1 text-sm font-semibold text-foreground">Settings</h2>
        <Form method="post" className="mt-4 space-y-4">
          <input type="hidden" name="intent" value="save" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2 rounded-lg border border-border p-4">
              <Label htmlFor="rtk_enabled" className="flex items-center gap-2">
                <Checkbox
                  id="rtk_enabled"
                  name="rtk_enabled"
                  value="1"
                  defaultChecked={Boolean(settings.rtk_enabled)}
                />
                RTK enabled
              </Label>
              <div>
                <Label htmlFor="rtk_path">RTK binary path</Label>
                <Input id="rtk_path" name="rtk_binary_path" defaultValue={settings.rtk_binary_path} />
              </div>
            </div>
            <div className="space-y-4 rounded-lg border border-border p-4">
              <Label htmlFor="caveman_enabled" className="flex items-center gap-2">
                <Checkbox
                  id="caveman_enabled"
                  name="caveman_enabled"
                  value="1"
                  defaultChecked={Boolean(settings.caveman_enabled)}
                />
                Caveman enabled
              </Label>
              <div>
                <Label htmlFor="caveman_path">Caveman binary path</Label>
                <Input
                  id="caveman_path"
                  name="caveman_binary_path"
                  defaultValue={settings.caveman_binary_path}
                />
              </div>
            </div>
          </div>

          {actionData && "saved" in actionData ? (
            <p className="text-sm text-success">Settings saved.</p>
          ) : null}

          <div>
            <Button type="submit">Save settings</Button>
          </div>
        </Form>
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold text-foreground">Compression test</h2>
        <Form method="post" className="mt-4">
          <input type="hidden" name="intent" value="test" />
          <input type="hidden" name="rtk_binary_path" value={settings.rtk_binary_path} />
          <input type="hidden" name="caveman_binary_path" value={settings.caveman_binary_path} />
          <Label htmlFor="sample" className="mb-1">
            Sample prompt
          </Label>
          <Textarea
            id="sample"
            name="sample"
            rows={3}
            defaultValue="Example prompt for compression test (RTK &amp; Caveman)."
          />
          <Button type="submit" variant="secondary" className="mt-3">
            Run test
          </Button>
        </Form>

        {test ? (
          <pre className="mt-4 rounded-lg bg-muted p-4 text-xs text-foreground">
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
      </Card>
    </div>
  );
}
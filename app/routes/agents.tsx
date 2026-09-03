import { memo, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/agents";
import { Bot, ExternalLink, FileClock, RotateCcw, Trash2 } from "lucide-react";
import {
  HARNESS_REGISTRY,
  buildConfig,
  defaultMcpCommand,
  deleteBackup,
  installMcp,
  isHarnessId,
  isKeyRevealAllowed,
  isMcpInstalled,
  readBackup,
  readConfig,
  removeMcp,
  removeUniRouteFromConfig,
  restoreBackup,
  setKeyRevealAllowed,
  statusAll,
  writeHarnessConfig,
} from "../.server/agents-config";
import type { HarnessId, HarnessStatus } from "../.server/agents-config";
import { createClientKey, listClientKeys } from "../.server/client-key";
import { decryptKey } from "../.server/key-crypto";
import { getStructuredSuggestions } from "../.server/suggest";
import { getSessionToken, isValid } from "../.server/auth";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input, Label, Select } from "../components/ui/field";
import { Combobox } from "../components/combobox";
import { useConfirm } from "../components/ui/confirm-dialog";
import { Toggle } from "../components/ui/toggle";
import { Spinner } from "../components/ui/feedback";
import { useToast } from "../components/ui/toast";
import { fmtTs } from "../lib/log-format";

/* --------------------------------- loader --------------------------------- */

type KeyOption = { id: number; name: string; prefix: string; revealable: boolean };

export function loader() {
  const revealAllowed = isKeyRevealAllowed();
  const keys: KeyOption[] = listClientKeys()
    .filter((k) => k.is_active === 1)
    .map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.key_prefix,
      revealable: Boolean(k.key_enc),
    }));
  return {
    harnesses: statusAll(),
    baseUrl: process.env.BASE_URL || "http://localhost:3000",
    keys,
    revealAllowed,
    modelSuggestions: [...new Set(getStructuredSuggestions().map((s) => s.value))],
    mcp: {
      codex: isMcpInstalled("codex"),
      "claude-code": isMcpInstalled("claude-code"),
      opencode: isMcpInstalled("opencode"),
      command: defaultMcpCommand(),
    },
  };
}

/* --------------------------------- action --------------------------------- */

type KeyResolution =
  | { ok: true; key: string; created?: { id: number; name: string } }
  | { ok: false; error: string };

function resolveApiKey(
  form: FormData,
  harnessName: string,
  revealAllowed: boolean,
): KeyResolution {
  const mode = String(form.get("key_mode") ?? "new");
  if (mode === "manual") {
    const key = String(form.get("manual_key") ?? "").trim();
    if (!key) return { ok: false, error: "API key is required." };
    return { ok: true, key };
  }
  if (mode === "existing") {
    if (!revealAllowed) {
      return {
        ok: false,
        error:
          "Reusing stored keys is disabled. Enable the “Reuse stored keys” toggle at the top of this page (or set ALLOW_API_KEY_REVEAL=1 in the environment).",
      };
    }
    const id = Number(form.get("existing_key_id"));
    const row = listClientKeys().find((k) => k.id === id);
    if (!row) return { ok: false, error: "API key not found." };
    if (!row.key_enc) {
      return { ok: false, error: "This key has no recoverable secret." };
    }
    try {
      return { ok: true, key: decryptKey(row.key_enc) };
    } catch {
      return { ok: false, error: "Failed to decrypt the selected key." };
    }
  }
  // default: create a fresh key dedicated to this harness
  const name =
    String(form.get("new_key_name") ?? "").trim() || `${harnessName} (UniRoute)`;
  try {
    const created = createClientKey({ name, prefix: "sk-" });
    return { ok: true, key: created.key, created: { id: created.id, name } };
  } catch {
    return { ok: false, error: "Failed to create a new API key." };
  }
}

function parseInput(form: FormData): { base_url: string; model: string; auth_mode: "token" | "env" } {
  return {
    base_url: String(form.get("base_url") ?? "").trim(),
    model: String(form.get("model") ?? "").trim(),
    auth_mode: form.get("auth_mode") === "env" ? "env" : "token",
  };
}

function validateBaseUrl(raw: string): string | null {
  if (!raw) return "Base URL is required.";
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "Base URL must start with http:// or https://.";
    }
    return null;
  } catch {
    return "Base URL is not a valid URL.";
  }
}

export async function action({ request }: Route.ActionArgs) {
  // Actions run before the root loader guard on POST, so check the session here.
  if (!isValid(getSessionToken(request))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  // Global toggle: izinkan memakai key tersimpan (dekripsi) dari halaman ini.
  if (intent === "set-reveal") {
    setKeyRevealAllowed(form.get("enabled") === "1");
    return { ok: true as const, revealSet: true };
  }

  // Registrasi / copot MCP server UniRoute ke config agent.
  if (intent === "mcp-install" || intent === "mcp-remove") {
    if (!isValid(getSessionToken(request))) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }
    const harness = String(form.get("harness") ?? "");
    if (harness !== "codex" && harness !== "claude-code" && harness !== "opencode") {
      return Response.json({ ok: false, error: "unknown harness" }, { status: 400 });
    }
    try {
      const cmd = defaultMcpCommand();
      if (intent === "mcp-install") installMcp(harness, cmd);
      else removeMcp(harness);
      return { ok: true as const, mcpHarness: harness, installed: intent === "mcp-install" };
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : "failed" },
        { status: 500 },
      );
    }
  }

  if (
    intent === "restore" ||
    intent === "delete_backup" ||
    intent === "read_backup" ||
    intent === "remove"
  ) {
    const harness = String(form.get("harness") ?? "");
    const file = String(form.get("file") ?? "");
    if (!isHarnessId(harness)) {
      return Response.json({ ok: false, error: "Unknown agent." }, { status: 400 });
    }
    try {
      if (intent === "restore") {
        const { safetyBackup } = restoreBackup(harness, file);
        return {
          ok: true as const,
          restored: harness as HarnessId,
          file,
          safetyBackup,
        };
      }
      if (intent === "read_backup") {
        return { ok: true as const, backupContent: readBackup(harness, file), file };
      }
      if (intent === "remove") {
        const result = removeUniRouteFromConfig(harness);
        return {
          ok: true as const,
          removed: harness as HarnessId,
          path: result.path,
          safetyBackup: result.safetyBackup,
          fileDeleted: result.fileDeleted,
        };
      }
      deleteBackup(harness, file);
      return { ok: true as const, deletedBackup: file, harness: harness as HarnessId };
    } catch (err) {
      return Response.json(
        { ok: false, error: err instanceof Error ? err.message : "failed" },
        { status: 400 },
      );
    }
  }

  // preview & apply share input handling
  const harness = String(form.get("harness") ?? "");
  if (!isHarnessId(harness)) {
    return Response.json({ ok: false, error: "Unknown agent." }, { status: 400 });
  }
  const meta = HARNESS_REGISTRY[harness];
  const { base_url, model, auth_mode } = parseInput(form);

  const urlError = validateBaseUrl(base_url);
  if (urlError) return { ok: false as const, error: urlError };

  const resolved = resolveApiKey(form, meta.name, isKeyRevealAllowed());
  if (!resolved.ok) return { ok: false as const, error: resolved.error };
  const apiKey = resolved.key;
  const created = resolved.created ?? null;

  const input = { baseUrl: base_url, apiKey, model: model || null, authMode: auth_mode };

  if (intent === "preview") {
    try {
      const existing = readConfig(harness);
      return {
        ok: true as const,
        previewed: harness as HarnessId,
        content: buildConfig(harness, input, existing),
        merged: existing !== null && existing.trim() !== "",
      };
    } catch (err) {
      return { ok: false as const, error: message(err) };
    }
  }

  if (intent === "apply") {
    try {
      const result = writeHarnessConfig(harness, input);
      return {
        ok: true as const,
        applied: harness as HarnessId,
        path: result.path,
        safetyBackup: result.safetyBackup,
        created,
        usedEnvAuth: auth_mode === "env",
        envKeyName: "UNIROUTE_API_KEY",
      };
    } catch (err) {
      return { ok: false as const, error: message(err) };
    }
  }

  return Response.json({ ok: false, error: "Unknown intent." }, { status: 400 });

  function message(err: unknown): string {
    return err instanceof Error ? err.message : "Unexpected error.";
  }
}

/* ---------------------------------- UI ------------------------------------ */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

const KEY_MODES = [
  { value: "new", label: "Create new" },
  { value: "existing", label: "Use existing" },
  { value: "manual", label: "Paste key" },
];

type MainResult = Record<string, unknown>;

type ConfirmFn = (opts: {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
}) => Promise<boolean>;

const HarnessCard = memo(function HarnessCard({
  status,
  defaultBaseUrl,
  keys,
  revealAllowed,
  modelSuggestions,
  confirm,
}: {
  status: HarnessStatus;
  defaultBaseUrl: string;
  keys: KeyOption[];
  revealAllowed: boolean;
  modelSuggestions: string[];
  confirm: ConfirmFn;
}) {
  const id = status.id as HarnessId;
  const [keyMode, setKeyMode] = useState<"new" | "existing" | "manual">("new");
  const [authMode, setAuthMode] = useState<"token" | "env">("token");
  const [model, setModel] = useState("");
  const mainFetcher = useFetcher<MainResult>();
  const backupFetcher = useFetcher<MainResult>();
  const busy =
    mainFetcher.state !== "idle" || backupFetcher.state !== "idle";

  const data = mainFetcher.data ?? null;
  const backupData = backupFetcher.data ?? null;
  const { toast } = useToast();
  const lastMainRef = useRef<MainResult | null>(null);
  const lastBackupRef = useRef<MainResult | null>(null);
  const lastMainIntentRef = useRef<string | null>(null);

  // Remember which intent (preview vs apply) was submitted so failures can
  // be labeled — formData is only populated while the fetcher is busy.
  useEffect(() => {
    const intent = mainFetcher.formData?.get("intent");
    if (typeof intent === "string" && intent) lastMainIntentRef.current = intent;
  }, [mainFetcher.formData]);

  useEffect(() => {
    if (mainFetcher.state !== "idle" || !data) return;
    if (lastMainRef.current === data) return;
    lastMainRef.current = data;
    // Success outcomes already render prominent inline boxes (applied
    // confirmation, preview <pre>) — only failures (dull inline line) toast.
    if (data.applied || data.previewed) return;
    if (data.error) {
      toast({
        title:
          lastMainIntentRef.current === "apply"
            ? "Apply failed"
            : lastMainIntentRef.current === "preview"
              ? "Preview failed"
              : "Config action failed",
        description: String(data.error),
        variant: "error",
      });
    }
  }, [mainFetcher.state, data, toast]);

  useEffect(() => {
    if (backupFetcher.state !== "idle" || !backupData) return;
    if (lastBackupRef.current === backupData) return;
    lastBackupRef.current = backupData;
    // read_backup renders its content inline in <details> — skip it.
    if (backupData.backupContent) return;
    if (backupData.restored) {
      toast({
        title: "Backup restored",
        description: `Restored ${String(backupData.file)}`,
        variant: "success",
      });
    } else if (backupData.removed) {
      toast({
        title: "UniRoute config removed",
        description: String(backupData.path),
        variant: "success",
      });
    } else if (backupData.deletedBackup) {
      toast({
        title: "Backup deleted",
        description: `Deleted ${String(backupData.deletedBackup)}`,
        variant: "success",
      });
    } else if (backupData.error) {
      toast({
        title: "Backup action failed",
        description: String(backupData.error),
        variant: "error",
      });
    }
  }, [backupFetcher.state, backupData, toast]);

  const usableKeys = keys.filter((k) => k.revealable);

  return (
    <Card className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{status.name}</h2>
          <Badge
            tone={status.exists ? "success" : "neutral"}
            style="subtle"
          >
            {status.exists ? "configured" : "not found"}
          </Badge>
          <Badge
            tone={status.cliInstalled ? "success" : "warning"}
            style="subtle"
            title={
              status.cliInstalled
                ? `CLI detected at ${status.cliBin}`
                : `Install the CLI (${status.id === "claude-code" ? "claude" : status.id}) to use this config`
            }
          >
            {status.cliInstalled ? "CLI installed" : "CLI not detected"}
          </Badge>
          <Badge tone="info">{status.format.toUpperCase()}</Badge>
        </div>
        <a
          href={status.docsUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          docs <ExternalLink size={12} />
        </a>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{status.description}</p>
      <p className="mb-4 font-mono text-xs break-all text-muted-foreground">
        {status.absPath}
        {status.exists && status.size != null ? ` · ${fmtBytes(status.size)}` : ""}
        {status.updatedAt ? ` · updated ${fmtTs(status.updatedAt)}` : ""}
      </p>

      <mainFetcher.Form method="post">
        <input type="hidden" name="intent" value="preview" />
        <input type="hidden" name="harness" value={status.id} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label htmlFor={`${id}-base-url`}>Gateway base URL</Label>
            <Input
              id={`${id}-base-url`}
              name="base_url"
              defaultValue={defaultBaseUrl}
              placeholder="http://192.168.1.10:3000"
            />
          </div>
          <div>
            <Label>Default model or combo (optional)</Label>
            <Combobox
              options={modelSuggestions}
              value={model}
              onChange={setModel}
              name="model"
              placeholder="e.g. big-pickle / combo:coding"
              className="h-9 w-full rounded-lg border border-glass-border bg-glass-strong px-3 text-sm text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)] transition-colors placeholder:text-muted-foreground focus:border-primary/40 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          {id === "codex" ? (
            <div>
              <Label htmlFor={`${id}-auth-mode`}>Codex auth</Label>
              <Select
                id={`${id}-auth-mode`}
                name="auth_mode"
                value={authMode}
                onChange={(e) => setAuthMode(e.target.value as "token" | "env")}
              >
                <option value="token">Token in config (instant)</option>
                <option value="env">Env var UNIROUTE_API_KEY</option>
              </Select>
            </div>
          ) : null}
        </div>

        <div className="mt-3 rounded-lg border border-border p-3">
          <Label>API key</Label>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {KEY_MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                onClick={() => setKeyMode(m.value as typeof keyMode)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                  keyMode === m.value
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          {keyMode === "new" ? (
            <div>
              <Label htmlFor={`${id}-new-key-name`}>New key name</Label>
              <Input
                id={`${id}-new-key-name`}
                name="new_key_name"
                defaultValue={`${status.name} (UniRoute)`}
              />
            </div>
          ) : null}
          {keyMode === "existing" ? (
            <div>
              <Label htmlFor={`${id}-existing-key`}>Existing key</Label>
              <Select id={`${id}-existing-key`} name="existing_key_id">
                {usableKeys.length === 0 ? (
                  <option value="">No recoverable keys</option>
                ) : (
                  usableKeys.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name} ({k.prefix}…)
                    </option>
                  ))
                )}
              </Select>
              {!revealAllowed ? (
                <p className="mt-1 text-xs text-warning">
                  Reusing stored keys is disabled — flip the “Reuse stored keys” toggle above
                  (or set ALLOW_API_KEY_REVEAL=1).
                </p>
              ) : usableKeys.length === 0 ? (
                <p className="mt-1 text-xs text-warning">
                  Keys are only recoverable when UniRoute runs with{" "}
                  <span className="font-mono">API_KEY_SECRET</span> set. Restart with it
                  configured, then create (or rotate) the key so it is stored encrypted.
                </p>
              ) : null}
            </div>
          ) : null}
          {keyMode === "manual" ? (
            <div>
              <Label htmlFor={`${id}-manual-key`}>API key</Label>
              <Input
                id={`${id}-manual-key`}
                name="manual_key"
                type="password"
                placeholder="sk-…"
                autoComplete="off"
              />
            </div>
          ) : null}
        </div>

        {/* Preview uses this form; Apply reuses the same fields with a different intent. */}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="submit" variant="secondary" disabled={busy}>
            {mainFetcher.state !== "idle" && mainFetcher.formData?.get("intent") === "preview"
              ? "Generating…"
              : "Preview config"}
          </Button>
          <Button
            type="submit"
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const formEl = e.currentTarget.form;
              if (!formEl) return;
              void confirm({
                title: `Apply ${status.name} config?`,
                description: status.exists
                  ? `The existing file will be backed up to ~/.uniroute/backups/${status.id}/ first — you can restore it anytime.`
                  : `A new config will be written to ${status.absPath}.`,
                variant: "danger",
              }).then((ok) => {
                if (!ok) return;
                const fd = new FormData(formEl);
                fd.set("intent", "apply");
                void mainFetcher.submit(fd, { method: "post" });
              });
            }}
          >
            {mainFetcher.state !== "idle" && mainFetcher.formData?.get("intent") === "apply"
              ? "Applying…"
              : "Apply to disk"}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || !status.exists}
            className="gap-1.5 text-danger"
            title={
              status.exists
                ? "Strip UniRoute entries from this config (keeps your own settings)"
                : "No config file to clean"
            }
            onClick={() => {
              void confirm({
                title: `Remove UniRoute config from ${status.name}?`,
                description:
                  "UniRoute's entries are stripped and your own settings are kept. A safety backup is saved first — if nothing else remains, the file itself is deleted (back to default).",
                confirmLabel: "Remove",
                variant: "danger",
              }).then((ok) => {
                if (!ok) return;
                backupFetcher.submit(
                  { intent: "remove", harness: status.id },
                  { method: "post" },
                );
              });
            }}
          >
            <Trash2 size={14} /> Remove UniRoute config
          </Button>
        </div>
      </mainFetcher.Form>

      {data?.error ? (
        <p className="mt-3 text-xs text-danger">{String(data.error)}</p>
      ) : null}

      {data?.applied ? (
        <div className="mt-3 space-y-1 rounded-lg border border-success/40 bg-success/10 px-3 py-2 text-xs text-foreground">
          <p className="font-medium text-success">Config written ✓</p>
          <p className="font-mono break-all">{String(data.path)}</p>
          {data.safetyBackup ? (
            <p className="text-muted-foreground">
              Backup of previous file:{" "}
              <span className="font-mono">{String(data.safetyBackup)}</span>
            </p>
          ) : (
            <p className="text-muted-foreground">New file created.</p>
          )}
          {data.created ? (
            <p className="break-all text-muted-foreground">
              Created API key <span className="font-medium">{String((data.created as { name: string }).name)}</span>:{" "}
              <span className="font-mono text-foreground">{String((data.created as { key: string }).key)}</span>{" "}
              (shown once)
            </p>
          ) : null}
          {data.usedEnvAuth ? (
            <p className="break-all text-muted-foreground">
              Add to your shell profile:{" "}
              <span className="font-mono text-foreground">
                export {String(data.envKeyName)}=sk-…
              </span>
            </p>
          ) : null}
        </div>
      ) : null}

      {data?.previewed ? (
        <div className="mt-3">
          <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Preview {data.merged ? "(merged into existing)" : "(new file)"}
          </p>
          <pre className="max-h-72 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {String(data.content)}
          </pre>
        </div>
      ) : null}

      {backupData?.backupContent ? (
        <details className="mt-3">
          <summary className="cursor-pointer font-mono text-xs text-muted-foreground">
            {String(backupData.file)}
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-xs text-foreground">
            {String(backupData.backupContent)}
          </pre>
        </details>
      ) : null}

      <div className="mt-4 border-t border-border pt-3">
        <p className="mb-1 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <FileClock size={14} /> Backups ({status.backups.length})
        </p>
        <p className="mb-2 text-xs text-muted-foreground">
          Every Apply that overwrites an existing config first saves a timestamped copy to{" "}
          <span className="font-mono">~/.uniroute/backups/{status.id}/</span>. Use{" "}
          <span className="font-medium">View</span> to inspect a copy or{" "}
          <span className="font-medium">Restore</span> to write it back — the current file is
          backed up first, so restoring is reversible.
          {status.backups.length === 0
            ? " No backups yet: they appear after your first Apply over an existing config."
            : ""}
        </p>
        {status.backups.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Nothing to restore yet for this agent.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {status.backups.map((b) => (
              <li
                key={b.file}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-2.5 py-1.5 text-xs"
              >
                <span className="font-mono text-foreground">{b.file}</span>
                <span className="text-muted-foreground">
                  {fmtTs(b.ts)} · {fmtBytes(b.size)}
                </span>
                <span className="ml-auto flex gap-1.5">
                  <button
                    type="button"
                    title="View backup content"
                    onClick={() =>
                      backupFetcher.submit(
                        { intent: "read_backup", harness: status.id, file: b.file },
                        { method: "post" },
                      )
                    }
                    className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:bg-muted"
                  >
                    View
                  </button>
                  <button
                    type="button"
                    title="Restore this backup"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Restore this backup?",
                        description:
                          "The current config is backed up first, so restoring is reversible.",
                      });
                      if (!ok) return;
                      backupFetcher.submit(
                        { intent: "restore", harness: status.id, file: b.file },
                        { method: "post" },
                      );
                    }}
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-foreground hover:bg-muted"
                  >
                    <RotateCcw size={12} /> Restore
                  </button>
                  <button
                    type="button"
                    title="Delete backup"
                    onClick={async () => {
                      const ok = await confirm({
                        title: "Delete this backup?",
                        description: "This cannot be undone.",
                        variant: "danger",
                      });
                      if (!ok) return;
                      backupFetcher.submit(
                        { intent: "delete_backup", harness: status.id, file: b.file },
                        { method: "post" },
                      );
                    }}
                    className="rounded border border-border px-1.5 py-0.5 text-danger hover:bg-danger/10"
                  >
                    <Trash2 size={12} />
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {backupData?.restored ? (
        <p className="mt-3 text-xs text-success">
          Restored {String(backupData.file)}
          {backupData.safetyBackup
            ? ` · previous config saved as ${String(backupData.safetyBackup)}`
            : ""}
        </p>
      ) : null}
      {backupData?.removed ? (
        <p className="mt-3 text-xs text-success">
          UniRoute entries removed from{" "}
          <span className="font-mono">{String(backupData.path)}</span>
          {backupData.fileDeleted
            ? " — nothing else remained, so the file was deleted (back to default)."
            : "."}
          {backupData.safetyBackup
            ? ` Safety backup: ${String(backupData.safetyBackup)}`
            : ""}
        </p>
      ) : null}
      {backupData?.deletedBackup ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Deleted backup {String(backupData.deletedBackup)}.
        </p>
      ) : null}
      {backupData?.error ? (
        <p className="mt-3 text-xs text-danger">{String(backupData.error)}</p>
      ) : null}
    </Card>
  );
});

function McpRow({
  harness,
  label,
  installed,
}: {
  harness: "codex" | "claude-code" | "opencode";
  label: string;
  installed: boolean;
}) {
  const fetcher = useFetcher<{
    ok?: boolean;
    error?: string;
    mcpHarness?: string;
    installed?: boolean;
  }>();
  const busy = fetcher.state !== "idle";
  const isOn = installed;
  const { toast } = useToast();
  const lastMcpRef = useRef<typeof fetcher.data>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (lastMcpRef.current === fetcher.data) return;
    lastMcpRef.current = fetcher.data;
    if (fetcher.data.ok) {
      toast({
        title: fetcher.data.installed
          ? "MCP server registered"
          : "MCP server removed",
        description: label,
        variant: "success",
      });
    } else if (fetcher.data.error) {
      toast({
        title: "MCP update failed",
        description: String(fetcher.data.error),
        variant: "error",
      });
    }
  }, [fetcher.state, fetcher.data, toast, label]);
  return (
    <fetcher.Form method="post" className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
      <input type="hidden" name="harness" value={harness} />
      <input
        type="hidden"
        name="intent"
        value={isOn ? "mcp-remove" : "mcp-install"}
      />
      <span className="text-xs font-medium text-foreground">{label}</span>
      {busy ? (
        <Spinner size={14} />
      ) : (
        <Button type="submit" size="sm" variant={isOn ? "outline" : "secondary"}>
          {isOn ? "Remove" : "Register"}
        </Button>
      )}
    </fetcher.Form>
  );
}

export default function Agents({
  loaderData,
}: Route.ComponentProps) {
  const { dialog, confirm } = useConfirm();
  const revealFetcher = useFetcher<{ ok?: boolean }>();
  const revealPending = revealFetcher.state !== "idle";

  return (
    <div>
      <PageHeader
        title="AI Agents"
        icon={<Bot size={20} />}
        subtitle="Point local coding CLIs — Codex, Claude Code, OpenCode — at your UniRoute gateway."
      />

      <details className="mb-6 rounded-xl border border-border bg-surface/50 px-3 py-2">
        <summary className="cursor-pointer text-sm font-medium text-foreground">
          How it works & safety
        </summary>
        <ul className="mt-1.5 list-inside list-disc space-y-1 text-xs text-muted-foreground">
          <li>
            UniRoute writes the harness config file directly on the server host so the CLI
            routes requests through your gateway (models, keys, quotas and logs included).
          </li>
          <li>
            Before any overwrite the current file is copied to{" "}
            <span className="font-mono break-all">~/.uniroute/backups/&lt;agent&gt;/</span> — restore
            anytime from the backups list below each card.
          </li>
          <li>
            JSON configs are merged, not replaced: unrelated settings are preserved. Files
            that fail to parse are never overwritten.
          </li>
          <li>Writes are atomic (temp file + rename) with 0600 permissions.</li>
        </ul>
      </details>

      <Card className="mb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="shrink-0 text-sm font-semibold text-foreground">MCP Server</h2>
          <code className="max-w-full truncate rounded bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
            {loaderData.mcp.command.join(" ")}
          </code>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Expose UniRoute as an MCP server so coding agents can manage it with
          natural language — stats, providers, proxies, pools, keys, logs and
          test completions. Registering writes the entry into each harness
          config (with automatic backup).
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          <McpRow harness="codex" label="Codex CLI" installed={loaderData.mcp.codex} />
          <McpRow harness="claude-code" label="Claude Code" installed={loaderData.mcp["claude-code"]} />
          <McpRow harness="opencode" label="OpenCode" installed={loaderData.mcp.opencode} />
        </div>
      </Card>

      <Card className="mb-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="mb-1 text-sm font-semibold text-foreground">Stored API keys</h2>
            <p className="text-xs text-muted-foreground">
              Allow this page to reuse keys already saved in API Manager — they are picked by
              name and decrypted server-side, then written straight into the harness config.
              Keys are never displayed in full on this page.
            </p>
            {loaderData.revealAllowed ? (
              <p className="mt-1 text-xs text-success">
                Reusing stored keys is enabled — the “Use existing” option can decrypt and
                apply them.
              </p>
            ) : null}
          </div>
          <revealFetcher.Form method="post" id="reveal-form" className="shrink-0">
            <input type="hidden" name="intent" value="set-reveal" />
            <input
              type="hidden"
              name="enabled"
              value={loaderData.revealAllowed ? "0" : "1"}
            />
            <label className="flex items-center gap-2 text-xs font-medium text-foreground">
              Reuse stored keys
              <Toggle
                checked={loaderData.revealAllowed}
                label="Reuse stored keys"
                disabled={revealPending}
                onChange={() =>
                  (
                    document.getElementById("reveal-form") as HTMLFormElement | null
                  )?.requestSubmit()
                }
              />
            </label>
          </revealFetcher.Form>
        </div>
      </Card>

      {loaderData.harnesses.map((h) => (
        <HarnessCard
          key={h.id}
          status={h}
          defaultBaseUrl={loaderData.baseUrl}
          keys={loaderData.keys}
          revealAllowed={loaderData.revealAllowed}
          modelSuggestions={loaderData.modelSuggestions}
          confirm={confirm}
        />
      ))}

      {dialog}
    </div>
  );
}

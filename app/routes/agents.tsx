import { memo, useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import type { Route } from "./+types/agents";
import {
  ArrowRight,
  Bot,
  Cable,
  ExternalLink,
  FileCode2,
  FileClock,
  KeyRound,
  RotateCcw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  HARNESS_REGISTRY,
  buildConfig,
  defaultMcpCommand,
  deleteBackup,
  installMcp,
  isHarnessId,
  isKeyRevealAllowed,
  isKeyRevealLockedByEnv,
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
import { createClientKey, getClientKeyById, listClientKeys } from "../.server/client-key";
import { decryptKey } from "../.server/key-crypto";
import { getStructuredSuggestions } from "../.server/suggest";
import { getSessionToken, isValid, requireLoaderSession } from "../.server/auth";
import { getActiveTunnelUrl, resolveGatewayOrigin } from "../.server/tunnel";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Button, buttonClass } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input, Label, Select } from "../components/ui/field";
import { Table, TCell, THead, THeadCell, TRow } from "../components/ui/table";
import { Combobox } from "../components/ui/combobox";
import { useConfirm } from "../components/ui/confirm-dialog";
import { Toggle } from "../components/ui/toggle";
import { Spinner } from "../components/ui/feedback";
import { useToast } from "../components/ui/toast";
import { fmtTs } from "../lib/log-format";

export function meta() {
  return [{ title: "AI Agents | UniRoute" }];
}

/* --------------------------------- loader --------------------------------- */

type KeyOption = { id: number; name: string; prefix: string; revealable: boolean };

export function loader({ request }: Route.LoaderArgs) {
  requireLoaderSession(request);
  const revealAllowed = isKeyRevealAllowed();
  const revealLockedByEnv = isKeyRevealLockedByEnv();
  const keys: KeyOption[] = listClientKeys()
    .filter((k) => k.is_active === 1)
    .map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.key_prefix,
      revealable: Boolean(k.key_enc),
    }));
  const harnesses = statusAll();
  const byId = new Map(harnesses.map((h) => [h.id, h]));
  const reqUrl = new URL(request.url);
  const localPort = Number(process.env.PORT ?? reqUrl.port) || 3000;
  return {
    harnesses,
    baseUrl: resolveGatewayOrigin(request),
    localBaseUrl: `http://127.0.0.1:${localPort}`,
    tunnelBaseUrl: getActiveTunnelUrl(),
    keys,
    revealAllowed,
    revealLockedByEnv,
    modelSuggestions: [...new Set(getStructuredSuggestions().map((s) => s.value))],
    mcp: {
      codex: byId.get("codex")?.mcpInstalled ?? false,
      "claude-code": byId.get("claude-code")?.mcpInstalled ?? false,
      opencode: byId.get("opencode")?.mcpInstalled ?? false,
      command: defaultMcpCommand(),
    },
  };
}

/* --------------------------------- action --------------------------------- */

type KeyResolution =
  | { ok: true; key: string; created?: { id: number; name: string; key: string } }
  | { ok: false; error: string };

function resolveApiKey(
  form: FormData,
  harnessName: string,
  revealAllowed: boolean,
  isPreview: boolean,
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
    const row = getClientKeyById(id);
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
  // Preview should never mutate SQLite or create stray keys.
  if (isPreview) {
    return { ok: true, key: "sk-<new-key-generated-on-apply>" };
  }
  // default: create a fresh key dedicated to this harness
  const name =
    String(form.get("new_key_name") ?? "").trim() || `${harnessName} (UniRoute)`;
  try {
    const created = createClientKey({ name, prefix: "sk-" });
    return { ok: true, key: created.key, created: { id: created.id, name, key: created.key } };
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
    if (isKeyRevealLockedByEnv()) {
      return {
        ok: false as const,
        error: "Controlled by ALLOW_API_KEY_REVEAL=1 environment variable.",
      };
    }
    setKeyRevealAllowed(form.get("enabled") === "1");
    return { ok: true as const, revealSet: true };
  }

  // Registrasi / copot MCP server UniRoute ke config agent.
  if (intent === "mcp-install" || intent === "mcp-remove") {
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
    intent === "read_current" ||
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
      if (intent === "read_current") {
        const current = readConfig(harness);
        if (current === null) {
          return Response.json(
            { ok: false, error: "No config file exists on disk yet." },
            { status: 404 },
          );
        }
        return {
          ok: true as const,
          currentContent: current,
          file: HARNESS_REGISTRY[harness].configPath,
        };
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

  const resolved = resolveApiKey(form, meta.name, isKeyRevealAllowed(), intent === "preview");
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
  localBaseUrl,
  tunnelBaseUrl,
  keys,
  revealAllowed,
  modelSuggestions,
  confirm,
}: {
  status: HarnessStatus;
  defaultBaseUrl: string;
  localBaseUrl: string;
  tunnelBaseUrl: string | null;
  keys: KeyOption[];
  revealAllowed: boolean;
  modelSuggestions: string[];
  confirm: ConfirmFn;
}) {
  const id = status.id as HarnessId;
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [keyMode, setKeyMode] = useState<"new" | "existing" | "manual">("new");
  const [authMode, setAuthMode] = useState<"token" | "env">("token");
  const [model, setModel] = useState("");
  const [activeFeedback, setActiveFeedback] = useState<"main" | "backup" | null>(null);
  const [viewerClosed, setViewerClosed] = useState(false);
  const mainFetcher = useFetcher<MainResult>();
  const backupFetcher = useFetcher<MainResult>();
  const busy =
    mainFetcher.state !== "idle" || backupFetcher.state !== "idle";

  const data = activeFeedback === "main" ? (mainFetcher.data ?? null) : null;
  const backupData = activeFeedback === "backup" ? (backupFetcher.data ?? null) : null;
  const { toast } = useToast();
  const lastMainRef = useRef<MainResult | null>(null);
  const lastBackupRef = useRef<MainResult | null>(null);
  const lastMainIntentRef = useRef<string | null>(null);

  // Remember which fetcher / intent was last submitted so stale banners from
  // the other fetcher (e.g. Apply vs Remove) never appear side-by-side.
  useEffect(() => {
    const intent = mainFetcher.formData?.get("intent");
    if (typeof intent === "string" && intent) {
      lastMainIntentRef.current = intent;
      setActiveFeedback("main");
      setViewerClosed(false);
    }
  }, [mainFetcher.formData]);

  useEffect(() => {
    const intent = backupFetcher.formData?.get("intent");
    if (typeof intent === "string" && intent) {
      setActiveFeedback("backup");
      setViewerClosed(false);
    }
  }, [backupFetcher.formData]);

  useEffect(() => {
    const raw = mainFetcher.data ?? null;
    if (mainFetcher.state !== "idle" || !raw) return;
    if (lastMainRef.current === raw) return;
    lastMainRef.current = raw;
    if (raw.applied) {
      toast({
        title: `${status.name} config applied`,
        description: String(raw.path),
        variant: "success",
      });
      return;
    }
    if (raw.previewed) return;
    if (raw.error) {
      toast({
        title:
          lastMainIntentRef.current === "apply"
            ? "Apply failed"
            : lastMainIntentRef.current === "preview"
              ? "Preview failed"
              : "Config action failed",
        description: String(raw.error),
        variant: "error",
      });
    }
  }, [mainFetcher.state, mainFetcher.data, status.name, toast]);

  useEffect(() => {
    const raw = backupFetcher.data ?? null;
    if (backupFetcher.state !== "idle" || !raw) return;
    if (lastBackupRef.current === raw) return;
    lastBackupRef.current = raw;
    if (raw.backupContent || raw.currentContent) return;
    if (raw.restored) {
      toast({
        title: "Backup restored",
        description: `Restored ${String(raw.file)}`,
        variant: "success",
      });
    } else if (raw.removed) {
      toast({
        title: "UniRoute config removed",
        description: String(raw.path),
        variant: "success",
      });
    } else if (raw.deletedBackup) {
      toast({
        title: "Backup deleted",
        description: `Deleted ${String(raw.deletedBackup)}`,
        variant: "success",
      });
    } else if (raw.error) {
      toast({
        title: "Action failed",
        description: String(raw.error),
        variant: "error",
      });
    }
  }, [backupFetcher.state, backupFetcher.data, toast]);

  const usableKeys = keys.filter((k) => k.revealable);

  return (
    <Card className="mb-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-foreground">{status.name}</h2>
          <Badge
            tone={status.unirouteConfigured ? "success" : "neutral"}
            style="subtle"
            dot={status.unirouteConfigured}
            title={
              status.unirouteConfigured
                ? "UniRoute provider entries are active in this config file"
                : status.exists
                  ? "Config file exists on disk, but does not contain UniRoute entries"
                  : "Config file has not been created yet"
            }
          >
            {status.unirouteConfigured
              ? "UniRoute linked"
              : status.exists
                ? "File exists (not linked)"
                : "No config file"}
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
      <p className="mb-3 font-mono text-xs break-all text-muted-foreground">
        {status.absPath}
        {status.exists && status.size != null ? ` · ${fmtBytes(status.size)}` : ""}
        {status.updatedAt ? ` · updated ${fmtTs(status.updatedAt)}` : ""}
      </p>
      {status.unirouteConfigured && (status.unirouteBaseUrl || status.unirouteModel) ? (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-xs">
          <span className="font-medium text-success">Active UniRoute config</span>
          {status.unirouteBaseUrl ? (
            <span className="font-mono text-foreground">
              endpoint: {status.unirouteBaseUrl}
            </span>
          ) : null}
          {status.unirouteModel ? (
            <span className="font-mono text-foreground">
              model: {status.unirouteModel}
            </span>
          ) : null}
        </div>
      ) : null}

      <mainFetcher.Form method="post">
        <input type="hidden" name="intent" value="preview" />
        <input type="hidden" name="harness" value={status.id} />
        <input type="hidden" name="key_mode" value={keyMode} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={`${id}-base-url`}>Gateway base URL</Label>
              {tunnelBaseUrl ? (
                <div className="flex items-center gap-1 pb-1 text-[11px]">
                  <button
                    type="button"
                    onClick={() => setBaseUrl(localBaseUrl)}
                    className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                      baseUrl === localBaseUrl
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Local
                  </button>
                  <button
                    type="button"
                    onClick={() => setBaseUrl(tunnelBaseUrl)}
                    className={`rounded px-1.5 py-0.5 font-medium transition-colors ${
                      baseUrl === tunnelBaseUrl
                        ? "bg-primary/15 text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Tunnel
                  </button>
                </div>
              ) : null}
            </div>
            <Input
              id={`${id}-base-url`}
              name="base_url"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="http://127.0.0.1:3000"
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
                  Reusing stored keys is disabled. Flip the "Reuse stored keys" toggle above
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
                  ? `The existing file will be backed up to ~/.uniroute/backups/${status.id}/ first. You can restore it anytime.`
                  : `A new config will be written to ${status.absPath}.`,
                confirmLabel: "Apply to disk",
                variant: "primary",
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
            className="gap-1.5"
            title={
              status.exists
                ? "Inspect the current config file on disk"
                : "No config file exists on disk yet"
            }
            onClick={() => {
              backupFetcher.submit(
                { intent: "read_current", harness: status.id },
                { method: "post" },
              );
            }}
          >
            <FileCode2 size={14} aria-hidden="true" /> View current file
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={busy || !status.unirouteConfigured}
            className="gap-1.5"
            title={
              status.unirouteConfigured
                ? "Strip UniRoute entries from this config (keeps your own settings)"
                : status.exists
                  ? "UniRoute is not configured in this file"
                  : "No config file to clean"
            }
            onClick={() => {
              void confirm({
                title: `Remove UniRoute config from ${status.name}?`,
                description:
                  "UniRoute's entries are stripped and your own settings are kept. A safety backup is saved first; if nothing else remains, the file itself is deleted (back to default).",
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
          <p className="font-medium text-success">Config written</p>
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

      {data?.previewed && !viewerClosed ? (
        <div className="mt-3 rounded-xl border border-border-strong bg-surface-2/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Preview {data.merged ? "(merged into existing)" : "(new file)"}
            </p>
            <button
              type="button"
              onClick={() => setViewerClosed(true)}
              aria-label="Close preview"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <pre className="slim-scroll max-h-72 overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground">
            {String(data.content)}
          </pre>
        </div>
      ) : null}

      {(backupData?.backupContent || backupData?.currentContent) && !viewerClosed ? (
        <div className="mt-3 rounded-xl border border-border-strong bg-surface-2/40 p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="font-mono text-xs font-medium text-foreground">
              {backupData.currentContent ? "Current file: " : "Backup: "}
              {String(backupData.file)}
            </p>
            <button
              type="button"
              onClick={() => setViewerClosed(true)}
              aria-label="Close file viewer"
              className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          <pre className="slim-scroll max-h-72 overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs text-foreground">
            {String(backupData.currentContent ?? backupData.backupContent)}
          </pre>
        </div>
      ) : null}

      <div className="mt-6 border-t border-border pt-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            <FileClock size={14} aria-hidden="true" /> Config Backups ({status.backups.length})
          </p>
          <span className="font-mono text-[11px] text-muted-foreground">
            ~/.uniroute/backups/{status.id}/
          </span>
        </div>
        {status.backups.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface-2/35 px-3 py-4 text-center text-xs text-muted-foreground">
            No backups yet for {status.name}. Backups are created automatically whenever Apply overwrites an existing file.
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <Table className="min-w-[540px]">
              <THead>
                <TRow className="hover:bg-transparent">
                  <THeadCell>Backup File</THeadCell>
                  <THeadCell>Created</THeadCell>
                  <THeadCell>Size</THeadCell>
                  <THeadCell className="text-right">Actions</THeadCell>
                </TRow>
              </THead>
              <tbody>
                {status.backups.map((b) => (
                  <TRow key={b.file}>
                    <TCell className="font-mono text-xs text-foreground">{b.file}</TCell>
                    <TCell className="font-mono text-xs text-muted-foreground">{fmtTs(b.ts)}</TCell>
                    <TCell className="font-mono text-xs text-muted-foreground">{fmtBytes(b.size)}</TCell>
                    <TCell className="text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            backupFetcher.submit(
                              { intent: "read_backup", harness: status.id, file: b.file },
                              { method: "post" },
                            )
                          }
                        >
                          View
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
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
                        >
                          <RotateCcw size={12} aria-hidden="true" /> Restore
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="danger"
                          title="Delete backup"
                          aria-label={`Delete backup ${b.file}`}
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
                        >
                          <Trash2 size={12} aria-hidden="true" />
                        </Button>
                      </div>
                    </TCell>
                  </TRow>
                ))}
              </tbody>
            </Table>
          </div>
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
            ? ". Nothing else remained, so the file was deleted (back to default)."
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

export default function Agents({
  loaderData,
}: Route.ComponentProps) {
  const { dialog, confirm } = useConfirm();
  const revealFetcher = useFetcher<{ ok?: boolean }>();
  const revealPending = revealFetcher.state !== "idle";
  const [selectedId, setSelectedId] = useState<HarnessId>(
    loaderData.harnesses[0]?.id ?? "codex",
  );

  const selectedHarness =
    loaderData.harnesses.find((h) => h.id === selectedId) ?? loaderData.harnesses[0];
  const mcpCount = [
    loaderData.mcp.codex,
    loaderData.mcp["claude-code"],
    loaderData.mcp.opencode,
  ].filter(Boolean).length;

  return (
    <div>
      <PageHeader
        title="AI Agents"
        icon={<Bot size={20} />}
        subtitle="Connect local coding CLIs (Codex CLI, Claude Code, OpenCode) directly to your UniRoute gateway with automatic config backups."
      />

      {/* Compact top utilities row */}
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="flex flex-col justify-between gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <KeyRound size={15} className="text-primary" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-foreground">Stored API Keys</h2>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Allow reusing encrypted client keys from API Keys when writing agent configs.
              </p>
            </div>
            <revealFetcher.Form method="post" id="reveal-form" className="shrink-0">
              <input type="hidden" name="intent" value="set-reveal" />
              <input
                type="hidden"
                name="enabled"
                value={loaderData.revealAllowed ? "0" : "1"}
              />
              <Toggle
                checked={loaderData.revealAllowed}
                label="Reuse stored keys"
                disabled={revealPending || loaderData.revealLockedByEnv}
                onChange={() =>
                  (
                    document.getElementById("reveal-form") as HTMLFormElement | null
                  )?.requestSubmit()
                }
              />
            </revealFetcher.Form>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2.5 text-xs">
            <span className={loaderData.revealAllowed ? "font-medium text-success" : "text-muted-foreground"}>
              {loaderData.revealLockedByEnv
                ? "Locked on by ALLOW_API_KEY_REVEAL=1"
                : loaderData.revealAllowed
                  ? "Reuse enabled for existing keys"
                  : "Disabled (create new or paste key)"}
            </span>
            <Link
              to="/api-manager"
              prefetch="intent"
              className="inline-flex items-center gap-1 font-medium text-primary hover:underline"
            >
              Manage keys <ArrowRight size={12} aria-hidden="true" />
            </Link>
          </div>
        </Card>

        <Card className="flex flex-col justify-between gap-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Cable size={15} className="text-primary" aria-hidden="true" />
                <h2 className="text-sm font-semibold text-foreground">MCP Server Integration</h2>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Let coding agents inspect logs, providers, and keys via Model Context Protocol.
              </p>
            </div>
            <Badge tone={mcpCount > 0 ? "success" : "neutral"} dot>
              {mcpCount} / 3 registered
            </Badge>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-2.5 text-xs">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <ShieldCheck size={13} aria-hidden="true" />
              <span>Atomic writes + backups in ~/.uniroute/backups/</span>
            </div>
            <Link
              to="/mcp"
              prefetch="intent"
              className={buttonClass("outline", "sm")}
            >
              Open MCP Server
            </Link>
          </div>
        </Card>
      </div>

      {/* Agent Selector Tabs / Cards */}
      <div className="mb-4">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Select Coding Agent to Configure
        </p>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3" role="tablist" aria-label="Coding agents">
          {loaderData.harnesses.map((h) => {
            const active = h.id === selectedHarness?.id;
            const mcpOn = loaderData.mcp[h.id];
            return (
              <button
                key={h.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setSelectedId(h.id)}
                className={`rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                  active
                    ? "border-primary bg-primary/10"
                    : "border-border bg-surface hover:border-border-strong"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-foreground">{h.name}</span>
                  <Badge
                    tone={h.unirouteConfigured ? "success" : "neutral"}
                    dot={h.unirouteConfigured}
                  >
                    {h.unirouteConfigured
                      ? "UniRoute linked"
                      : h.exists
                        ? "Not linked"
                        : "No file"}
                  </Badge>
                </div>
                <p className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">
                  {h.configPath}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  <span>{h.cliInstalled ? "CLI ready" : "CLI missing"}</span>
                  <span>·</span>
                  <span>{h.backups.length} {h.backups.length === 1 ? "backup" : "backups"}</span>
                  <span>·</span>
                  <span>MCP: {mcpOn ? "on" : "off"}</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Focused Configurator Workbench for the selected agent */}
      {selectedHarness ? (
        <HarnessCard
          key={selectedHarness.id}
          status={selectedHarness}
          defaultBaseUrl={loaderData.baseUrl}
          localBaseUrl={loaderData.localBaseUrl}
          tunnelBaseUrl={loaderData.tunnelBaseUrl}
          keys={loaderData.keys}
          revealAllowed={loaderData.revealAllowed}
          modelSuggestions={loaderData.modelSuggestions}
          confirm={confirm}
        />
      ) : null}

      {dialog}
    </div>
  );
}

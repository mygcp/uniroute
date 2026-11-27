import { useEffect, useMemo, useRef, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import type { Route } from "./+types/updates";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ExternalLink,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import { requireLoaderSession, requireSession } from "../.server/auth";
import {
  applyAppUpdate,
  getInstallInfo,
  listGitHubReleases,
  scheduleAppRestart,
  type ApplyUpdateResult,
  type ReleaseSummary,
} from "../.server/self-update";
import { PageHeader } from "../components/ui/page-header";
import { MetricStrip } from "../components/ui/stat-card";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { CopyButton } from "../components/ui/copy-button";
import { Label, Select } from "../components/ui/field";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/feedback";
import { DownloadProgressBar } from "../components/download-progress-bar";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function meta() {
  return [{ title: "Updates | UniRoute" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  requireLoaderSession(request);
  const install = getInstallInfo();
  try {
    const catalog = await listGitHubReleases();
    return {
      install,
      catalog,
      releasesError: null as string | null,
    };
  } catch (err) {
    return {
      install,
      catalog: null,
      releasesError: err instanceof Error ? err.message : "Failed to load releases from GitHub.",
    };
  }
}

type ActionResult =
  | { ok: true; refreshed: true; count: number }
  | { ok: true; updated: ApplyUpdateResult }
  | { ok: true; restarted: { scheduled: boolean; message: string } }
  | { ok: false; error: string };

export async function action({ request }: Route.ActionArgs): Promise<ActionResult | Response> {
  const denied = requireSession(request);
  if (denied) return denied;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "refresh") {
    try {
      const catalog = await listGitHubReleases({ forceRefresh: true });
      return { ok: true, refreshed: true, count: catalog.releases.length };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to refresh releases.",
      };
    }
  }

  if (intent === "update") {
    const target = String(form.get("target") ?? "latest").trim() || "latest";
    const force = form.get("force") === "1";
    try {
      const updated = await applyAppUpdate({ target, force });
      return { ok: true, updated };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Update failed.",
      };
    }
  }

  if (intent === "restart") {
    return { ok: true, restarted: scheduleAppRestart() };
  }

  return Response.json({ ok: false, error: "Unknown action intent." }, { status: 400 });
}

function fmtBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return "-";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(iso?: string): string {
  if (!iso) return "Unknown date";
  return iso.slice(0, 10);
}

const MODE_LABEL: Record<string, string> = {
  bundle: "Prebuilt bundle (~1 MB)",
  binary: "Standalone binary",
  source: "Source checkout",
};

export default function UpdatesPage({ loaderData }: Route.ComponentProps) {
  const { install, catalog, releasesError } = loaderData;
  const fetcher = useFetcher<ActionResult>();
  const refreshFetcher = useFetcher<ActionResult>();
  const restartFetcher = useFetcher<ActionResult>();
  const revalidator = useRevalidator();
  const { confirm, dialog } = useConfirm();
  const { toast } = useToast();
  const lastFeedbackRef = useRef<unknown>(null);

  const releases = catalog?.releases ?? [];
  const latestTag = catalog?.latestTag ?? releases[0]?.tag ?? null;
  const [selectedTarget, setSelectedTarget] = useState<string>("latest");
  const [restarting, setRestarting] = useState(false);

  const selectedRelease: ReleaseSummary | null = useMemo(() => {
    if (releases.length === 0) return null;
    if (selectedTarget === "latest") {
      return releases.find((r) => r.isLatest) ?? releases[0] ?? null;
    }
    return releases.find((r) => r.tag === selectedTarget) ?? null;
  }, [releases, selectedTarget]);

  const isSameVersion = Boolean(selectedRelease?.isCurrent);
  const isUpdating = fetcher.state !== "idle";
  const isRefreshing = refreshFetcher.state !== "idle";
  const updateResult =
    fetcher.data && "updated" in fetcher.data ? fetcher.data.updated : null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || lastFeedbackRef.current === fetcher.data) {
      return;
    }
    lastFeedbackRef.current = fetcher.data;
    if ("error" in fetcher.data) {
      toast({ title: "Update failed", description: fetcher.data.error, variant: "error" });
    } else if ("updated" in fetcher.data) {
      const u = fetcher.data.updated;
      toast({
        title: u.alreadyUpToDate ? "Already on target version" : `Installed ${u.tag}`,
        description: u.alreadyUpToDate
          ? `Currently running ${u.tag}.`
          : `Updated from v${u.fromVersion} to v${u.toVersion}.`,
        variant: "success",
      });
    }
  }, [fetcher.state, fetcher.data, toast]);

  useEffect(() => {
    if (
      refreshFetcher.state !== "idle" ||
      !refreshFetcher.data ||
      lastFeedbackRef.current === refreshFetcher.data
    ) {
      return;
    }
    lastFeedbackRef.current = refreshFetcher.data;
    if ("error" in refreshFetcher.data) {
      toast({ title: "Refresh failed", description: refreshFetcher.data.error, variant: "error" });
    } else if ("refreshed" in refreshFetcher.data) {
      toast({
        title: "Releases refreshed",
        description: `Found ${refreshFetcher.data.count} release(s) on GitHub.`,
        variant: "success",
      });
      revalidator.revalidate();
    }
  }, [refreshFetcher.state, refreshFetcher.data, toast, revalidator]);

  useEffect(() => {
    if (!restarting) return;
    const iv = setInterval(async () => {
      try {
        const res = await fetch("/login", { method: "HEAD" });
        if (res.ok) {
          clearInterval(iv);
          window.location.reload();
        }
      } catch {
        // server is still restarting
      }
    }, 1200);
    return () => clearInterval(iv);
  }, [restarting]);

  const submitUpdate = async (force = false) => {
    const label = selectedTarget === "latest" ? `latest (${latestTag ?? "latest"})` : selectedTarget;
    if (isSameVersion && !force) {
      const ok = await confirm({
        title: `Reinstall ${label}?`,
        description: `UniRoute is already running v${install.currentVersion}. Reinstalling will re-download and replace the current installation.`,
        confirmLabel: "Reinstall",
        variant: "primary",
      });
      if (!ok) return;
      force = true;
    } else if (selectedTarget !== "latest" && selectedRelease && !selectedRelease.isLatest) {
      const ok = await confirm({
        title: `Switch to ${selectedRelease.tag}?`,
        description: `This installs ${selectedRelease.tag} (${fmtDate(selectedRelease.publishedAt)}) over your current v${install.currentVersion} installation.`,
        confirmLabel: `Install ${selectedRelease.tag}`,
        variant: "primary",
      });
      if (!ok) return;
    }

    const fd = new FormData();
    fd.set("intent", "update");
    fd.set("target", selectedTarget);
    if (force) fd.set("force", "1");
    fetcher.submit(fd, { method: "post" });
  };

  const gitCmd = selectedRelease
    ? `git fetch --tags && git checkout ${selectedRelease.tag} && bun install && bun run build`
    : "git fetch --tags && git pull && bun install && bun run build";

  return (
    <div>
      {dialog}
      <PageHeader
        title="Updates"
        subtitle="Check GitHub releases, switch between tagged versions or latest, and manage your UniRoute installation."
        actions={
          <refreshFetcher.Form method="post">
            <input type="hidden" name="intent" value="refresh" />
            <Button type="submit" variant="outline" size="sm" disabled={isRefreshing || isUpdating}>
              {isRefreshing ? <Spinner size={14} /> : <RefreshCw size={14} aria-hidden="true" />}
              Check releases
            </Button>
          </refreshFetcher.Form>
        }
      />

      <MetricStrip
        className="mb-6"
        items={[
          {
            label: "Installed version",
            value: `v${install.currentVersion}`,
            detail:
              latestTag && latestTag.replace(/^v/i, "") !== install.currentVersion
                ? `Latest available: ${latestTag}`
                : "Up to date with latest",
            tone:
              latestTag && latestTag.replace(/^v/i, "") !== install.currentVersion
                ? "warning"
                : "success",
          },
          {
            label: "Install mode",
            value: MODE_LABEL[install.installMode] ?? install.installMode,
            detail: `${install.platform}/${install.arch}`,
          },
          {
            label: "Runtime",
            value: `${install.runtime === "bun" ? "Bun" : "Node.js"} ${install.runtimeVersion}`,
            detail: install.canSelfUpdate ? "In-app updates supported" : "Managed via git",
          },
          {
            label: "Repository",
            value: install.repo,
            detail: `${releases.length} published release${releases.length === 1 ? "" : "s"}`,
          },
        ]}
      />

      {updateResult?.restartRequired ? (
        <div className="mb-6 flex flex-col justify-between gap-3 rounded-lg border border-success/40 bg-success/10 p-4 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-success" aria-hidden="true" />
            <div>
              <p className="text-sm font-semibold text-foreground">
                Installed {updateResult.tag} ({updateResult.mode})
              </p>
              <p className="text-xs text-muted-foreground">
                Restart UniRoute to activate v{updateResult.toVersion}.
              </p>
            </div>
          </div>
          <restartFetcher.Form
            method="post"
            onSubmit={() => setRestarting(true)}
          >
            <input type="hidden" name="intent" value="restart" />
            <Button type="submit" size="sm" variant="primary" disabled={restarting}>
              {restarting ? <Spinner size={14} /> : <RotateCcw size={14} aria-hidden="true" />}
              {restarting ? "Restarting..." : "Restart UniRoute"}
            </Button>
          </restartFetcher.Form>
        </div>
      ) : null}

      {releasesError ? (
        <Card className="mb-6 border-danger/40">
          <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-start gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  Could not load releases from GitHub
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">{releasesError}</p>
              </div>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => revalidator.revalidate()}
            >
              <RefreshCw size={14} aria-hidden="true" />
              Retry
            </Button>
          </div>
        </Card>
      ) : null}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-7">
          <Card>
            <CardHeader>
              <CardTitle>Target version</CardTitle>
              {latestTag ? (
                <Badge tone="info">Latest: {latestTag}</Badge>
              ) : null}
            </CardHeader>

            {releases.length === 0 && !releasesError ? (
              <EmptyState
                icon={<ArrowUpCircle size={22} />}
                title="No releases found"
                description={`No published tags were returned for ${install.repo}.`}
                action={
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => revalidator.revalidate()}
                  >
                    Check again
                  </Button>
                }
              />
            ) : (
              <div className="space-y-4">
                <div>
                  <Label htmlFor="target-release">Select release tag or latest</Label>
                  <Select
                    id="target-release"
                    value={selectedTarget}
                    onChange={(e) => setSelectedTarget(e.target.value)}
                    disabled={isUpdating}
                  >
                    <option value="latest">
                      Latest release{latestTag ? ` (${latestTag})` : ""}
                    </option>
                    {releases.map((r) => {
                      const marks = [
                        r.isCurrent ? "current" : null,
                        r.isLatest ? "latest" : null,
                        r.prerelease ? "prerelease" : null,
                      ]
                        .filter(Boolean)
                        .join(", ");
                      return (
                        <option key={r.tag} value={r.tag}>
                          {r.tag} ({fmtDate(r.publishedAt)}){marks ? ` - ${marks}` : ""}
                        </option>
                      );
                    })}
                  </Select>
                </div>

                <DownloadProgressBar
                  progressKey="app:self-update"
                  active={isUpdating}
                />

                {!install.canSelfUpdate ? (
                  <div className="space-y-2 rounded-md border border-border bg-surface-2 p-3">
                    <p className="text-xs font-medium text-foreground">
                      Source checkout mode detected
                    </p>
                    <p className="text-xs text-muted-foreground">
                      In-app updates are enabled for bundle and standalone binary installs. Switch versions in this checkout using git:
                    </p>
                    <div className="flex items-center justify-between gap-2 rounded border border-border bg-surface px-2.5 py-1.5">
                      <code className="overflow-x-auto font-mono text-xs text-foreground">
                        {gitCmd}
                      </code>
                      <CopyButton text={gitCmd} label="Copy git update command" />
                    </div>
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    variant="primary"
                    disabled={!install.canSelfUpdate || isUpdating || !selectedRelease}
                    onClick={() => void submitUpdate(false)}
                  >
                    {isUpdating ? (
                      <Spinner size={14} />
                    ) : (
                      <ArrowUpCircle size={15} aria-hidden="true" />
                    )}
                    {isUpdating
                      ? "Installing..."
                      : selectedTarget === "latest"
                        ? "Update to latest"
                        : isSameVersion
                          ? `Reinstall ${selectedTarget}`
                          : `Install ${selectedTarget}`}
                  </Button>

                  {selectedRelease?.htmlUrl ? (
                    <a
                      href={selectedRelease.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-h-[44px] sm:min-h-[36px] items-center gap-1.5 rounded-md border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:border-border-strong hover:bg-surface-2"
                    >
                      View on GitHub
                      <ExternalLink size={13} aria-hidden="true" />
                    </a>
                  ) : null}
                </div>
              </div>
            )}
          </Card>

          {selectedRelease ? (
            <Card>
              <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                  <CardTitle>{selectedRelease.name}</CardTitle>
                  <Badge tone="neutral">{selectedRelease.tag}</Badge>
                  {selectedRelease.isCurrent ? <Badge tone="success">Installed</Badge> : null}
                  {selectedRelease.isLatest ? <Badge tone="info">Latest</Badge> : null}
                  {selectedRelease.prerelease ? <Badge tone="warning">Prerelease</Badge> : null}
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {fmtDate(selectedRelease.publishedAt)}
                </span>
              </CardHeader>

              <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span className="rounded border border-border bg-surface-2 px-2 py-1 font-mono">
                  Bundle: {selectedRelease.hasBundleAsset ? fmtBytes(selectedRelease.bundleSizeBytes) : "Unavailable"}
                </span>
                <span className="rounded border border-border bg-surface-2 px-2 py-1 font-mono">
                  Binary: {selectedRelease.hasBinaryAsset ? fmtBytes(selectedRelease.binarySizeBytes) : "Unavailable"}
                </span>
              </div>

              {selectedRelease.body ? (
                <pre className="slim-scroll max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-surface-2 p-3 font-mono text-xs leading-relaxed text-foreground">
                  {selectedRelease.body}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No release notes provided for {selectedRelease.tag}.
                </p>
              )}
            </Card>
          ) : null}
        </div>

        <div className="space-y-5 lg:col-span-5">
          <Card>
            <CardHeader>
              <CardTitle>CLI update commands</CardTitle>
            </CardHeader>
            <p className="mb-3 text-xs text-muted-foreground">
              You can also list, pick interactively, or pin a specific tag from the terminal.
            </p>
            <div className="space-y-2.5 text-xs">
              {[
                { label: "Install latest", cmd: "uni update" },
                { label: "List all tags", cmd: "uni update --list" },
                { label: "Interactive picker", cmd: "uni update --select" },
                {
                  label: "Install selected tag",
                  cmd: `uni update --version ${selectedRelease?.tag ?? "v1.1.0"}`,
                },
              ].map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface-2 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-[11px] text-muted-foreground">{row.label}</p>
                    <code className="block truncate font-mono text-xs text-foreground">
                      {row.cmd}
                    </code>
                  </div>
                  <CopyButton text={row.cmd} label={`Copy ${row.label} command`} />
                </div>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>All releases</CardTitle>
              <span className="text-xs tabular-nums text-muted-foreground">
                {releases.length} tag{releases.length === 1 ? "" : "s"}
              </span>
            </CardHeader>
            {releases.length === 0 ? (
              <p className="text-xs text-muted-foreground">No tags available.</p>
            ) : (
              <div className="slim-scroll max-h-80 divide-y divide-border overflow-y-auto">
                {releases.map((r) => {
                  const active = selectedRelease?.tag === r.tag;
                  return (
                    <button
                      key={r.tag}
                      type="button"
                      onClick={() => setSelectedTarget(r.tag)}
                      className={`flex min-h-[44px] w-full items-center justify-between gap-2 px-2 py-2 text-left text-xs transition-colors ${
                        active ? "bg-primary/12 text-foreground" : "hover:bg-surface-2"
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-medium text-foreground">
                            {r.tag}
                          </span>
                          {r.isCurrent ? <Badge tone="success">Current</Badge> : null}
                          {r.isLatest ? <Badge tone="info">Latest</Badge> : null}
                        </div>
                        <p className="text-[11px] text-muted-foreground">
                          {fmtDate(r.publishedAt)}
                        </p>
                      </div>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {r.hasBundleAsset ? fmtBytes(r.bundleSizeBytes) : "source"}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

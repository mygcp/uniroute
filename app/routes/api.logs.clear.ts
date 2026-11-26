import type { Route } from "./+types/api.logs.clear";
import { requireSession } from "../.server/auth";
import { exec } from "../.server/db";

export async function action({ request }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;

  const form = await request.formData();
  const scope = String(form.get("scope") ?? "");

  if (scope !== "request" && scope !== "proxy") {
    return Response.json(
      { ok: false, error: "scope must be 'request' or 'proxy'" },
      { status: 400 },
    );
  }

  const table = scope === "request" ? "request_logs" : "proxy_logs";
  exec(`DELETE FROM ${table}`);
  try {
    exec("PRAGMA wal_checkpoint(PASSIVE)");
  } catch {
    /* ignore */
  }

  return Response.json({ ok: true, scope });
}

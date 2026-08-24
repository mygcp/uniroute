import type { Route } from "./+types/api.logs.clear";
import { getSessionToken, isValid } from "../.server/auth";
import { exec } from "../.server/db";

/**
 * POST /api/logs/clear — hapus semua log dari satu tabel.
 * Form fields: scope = "request" | "proxy".
 */
export async function action({ request }: Route.ActionArgs) {
  if (!isValid(getSessionToken(request))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

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

  return Response.json({ ok: true, scope });
}

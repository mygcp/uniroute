import type { Route } from "./+types/api.logs.delete";
import { getSessionToken, isValid } from "../.server/auth";
import { query } from "../.server/db";

/**
 * POST /api/logs/delete — hapus satu baris log.
 * Form fields: id (number), type = "request" | "proxy".
 */
export async function action({ request }: Route.ActionArgs) {
  if (!isValid(getSessionToken(request))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const id = Number(form.get("id"));
  const type = String(form.get("type") ?? "");

  if (!Number.isFinite(id) || id <= 0) {
    return Response.json(
      { ok: false, error: "valid id is required" },
      { status: 400 },
    );
  }
  if (type !== "request" && type !== "proxy") {
    return Response.json(
      { ok: false, error: "type must be 'request' or 'proxy'" },
      { status: 400 },
    );
  }

  const table = type === "request" ? "request_logs" : "proxy_logs";
  const result = query(`DELETE FROM ${table} WHERE id = ?`).run(id) as {
    changes?: number | bigint;
  };

  return Response.json({ ok: true, id, type, deleted: Number(result.changes ?? 0) });
}

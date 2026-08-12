import { redirect } from "react-router";
import type { Route } from "./+types/api.logs.delete";
import { query } from "../.server/db";

/**
 * Deletes a single log row. Expects form data: `type` ("request" | "proxy")
 * and `id`. Returns a plain JSON response so the page can refresh.
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const type = String(form.get("type") ?? "");
  const id = Number(form.get("id"));
  if (type !== "request" && type !== "proxy") {
    return Response.json({ ok: false, error: "invalid type" }, { status: 400 });
  }
  if (!Number.isFinite(id) || id <= 0) {
    return Response.json({ ok: false, error: "invalid id" }, { status: 400 });
  }
  const stmt =
    type === "request"
      ? query("DELETE FROM request_logs WHERE id = ?")
      : query("DELETE FROM proxy_logs WHERE id = ?");
  stmt.run(id);
  return Response.json({ ok: true });
}
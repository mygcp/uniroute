import type { Route } from "./+types/api.logs.clear";
import { exec } from "../.server/db";

/**
 * Clears all logs. Expects form data `scope` ("all" | "request" | "proxy").
 */
export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const scope = String(form.get("scope") ?? "all");
  if (scope === "request" || scope === "all") {
    exec("DELETE FROM request_logs");
  }
  if (scope === "proxy" || scope === "all") {
    exec("DELETE FROM proxy_logs");
  }
  return Response.json({ ok: true });
}
import type { Route } from "./+types/api-manager.$id.export";
import { requireSession } from "../.server/auth";
import { getClientKeyById } from "../.server/client-key";
import { listAudit } from "../.server/key-audit";

export function loader({ request, params }: Route.LoaderArgs) {
  const denied = requireSession(request);
  if (denied) return denied;
  const id = Number(params.id);
  const key = getClientKeyById(id);
  if (!key) throw new Response("Not found", { status: 404 });

  const audit = listAudit(id, 500);
  const header = "id,time,action,model,provider_id,status,tokens,cost,ip,details";
  const rows = audit.map((a) =>
    [
      a.id,
      a.created_at,
      a.action,
      csv(a.model),
      csv(a.provider_id),
      a.status ?? "",
      a.tokens ?? "",
      a.cost ?? "",
      csv(a.ip),
      csv(a.details),
    ].join(","),
  );
  const body = [header, ...rows].join("\n");
  return new Response(body, {
    headers: {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="api-key-${id}-audit.csv"`,
    },
  });
}

function csv(v: string | null | undefined): string {
  const raw = v ?? "";
  const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}
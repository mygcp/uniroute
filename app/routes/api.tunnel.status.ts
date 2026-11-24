import { requireSession } from "../.server/auth";
import { getTunnelStatus } from "../.server/tunnel";
import type { Route } from "./+types/api.tunnel.status";

export async function loader({ request }: Route.LoaderArgs) {
  const denied = requireSession(request);
  if (denied) return denied;
  return Response.json(getTunnelStatus());
}

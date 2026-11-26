import type { Route } from "./+types/api.tools.progress";
import { requireLoaderSession } from "../.server/auth";
import { getDownloadProgress } from "../.server/tool-exec-utils";

export function loader({ request }: Route.LoaderArgs) {
  requireLoaderSession(request);
  const key = new URL(request.url).searchParams.get("key")?.trim() ?? "";
  const progress = key ? getDownloadProgress(key) : null;
  return Response.json(progress ?? { key, status: "idle" }, {
    headers: { "Cache-Control": "no-store" },
  });
}

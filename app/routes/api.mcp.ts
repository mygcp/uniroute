import type { Route } from "./+types/api.mcp";
import { handleMcpHttpRequest } from "../.server/mcp-http";

export async function loader({ request }: Route.LoaderArgs) {
  return handleMcpHttpRequest(request);
}

export async function action({ request }: Route.ActionArgs) {
  return handleMcpHttpRequest(request);
}

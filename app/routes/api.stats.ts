import type { Route } from "./+types/api.stats";
import { getStats } from "../.server/stats";

export async function loader(_: Route.LoaderArgs) {
  return Response.json(getStats());
}
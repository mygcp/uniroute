import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import {
  clearSessionCookie,
  destroySession,
  getSessionToken,
  requireSession,
} from "../.server/auth";

export function loader() {
  return redirect("/home");
}

export async function action({ request }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;
  const token = getSessionToken(request);
  if (token) destroySession(token);
  const response = redirect("/login");
  clearSessionCookie(response, request);
  return response;
}
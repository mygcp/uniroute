import { redirect } from "react-router";
import type { Route } from "./+types/logout";
import {
  clearSessionCookie,
  destroySession,
  getSessionToken,
} from "../.server/auth";

export function loader() {
  return redirect("/home");
}

export async function action({ request }: Route.ActionArgs) {
  const token = getSessionToken(request);
  if (token) destroySession(token);
  const response = redirect("/login");
  clearSessionCookie(response);
  return response;
}
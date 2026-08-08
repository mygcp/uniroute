import { Form, redirect } from "react-router";
import type { Route } from "./+types/login";
import {
  createSession,
  setSessionCookie,
  verifyPassword,
} from "../.server/auth";

export function meta() {
  return [{ title: "Login — UniRoute" }];
}

export function loader({ request }: Route.LoaderArgs) {
  const next = new URL(request.url).searchParams.get("next");
  return { next: next && next.startsWith("/") ? next : "/home" };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const next = String(form.get("next") ?? "/home");

  if (!verifyPassword(password)) {
    return { error: "Password salah", next };
  }

  const token = createSession();
  const response = redirect(next.startsWith("/") ? next : "/home");
  setSessionCookie(response, token);
  return response;
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const next =
    actionData && "next" in actionData ? String(actionData.next) : loaderData.next;
  const error =
    actionData && "error" in actionData ? String(actionData.error) : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-2xl font-bold text-gray-900">UniRoute</h1>
        <p className="mb-6 text-sm text-gray-500">
          AI Gateway Admin — masuk dengan password.
        </p>
        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <div>
            <label
              htmlFor="password"
              className="mb-1 block text-sm font-medium text-gray-700"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            />
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Login
          </button>
        </Form>
      </div>
    </main>
  );
}
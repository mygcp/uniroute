import { Form, redirect } from "react-router";
import type { Route } from "./+types/login";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/field";
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
    return { error: "Invalid password", next };
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
    <main className="flex min-h-screen items-center justify-center">
      <div className="mx-4 w-full max-w-sm rounded-2xl border border-glass-border bg-glass p-6 shadow-[0_24px_48px_rgba(0,0,0,0.35),inset_0_1px_0_var(--glass-highlight)] backdrop-blur-md sm:p-8">
        <h1 className="mb-1 text-2xl font-bold text-foreground">UniRoute</h1>
        <p className="mb-6 text-sm text-muted-foreground">
          AI Gateway Admin — sign in with your password.
        </p>
        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <div>
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              autoComplete="current-password"
            />
          </div>
          {error ? <p className="text-sm text-danger">{error}</p> : null}
          <Button type="submit" className="w-full">
            Login
          </Button>
        </Form>
      </div>
    </main>
  );
}
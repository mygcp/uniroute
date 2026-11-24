import { useState } from "react";
import { Form, redirect, useNavigation } from "react-router";
import { AlertCircle, Eye, EyeOff, Lock, Moon, Sun } from "lucide-react";
import type { Route } from "./+types/login";
import { BrandMark } from "../components/sidebar";
import { Button } from "../components/ui/button";
import { Input, Label } from "../components/ui/field";
import { Spinner } from "../components/ui/feedback";
import { useTheme } from "../hooks/use-theme";
import {
  createSession,
  getSessionToken,
  isValid,
  setSessionCookie,
  verifyPassword,
} from "../.server/auth";

export function meta() {
  return [{ title: "Sign in | UniRoute" }];
}

function safeNext(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/home";
}

export function loader({ request }: Route.LoaderArgs) {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  if (isValid(getSessionToken(request))) {
    return redirect(next);
  }
  return { next };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? "/home"));

  if (!verifyPassword(password)) {
    return { error: "Invalid password. Please try again.", next };
  }

  const token = createSession();
  const response = redirect(next);
  setSessionCookie(response, token);
  return response;
}

export default function Login({ loaderData, actionData }: Route.ComponentProps) {
  const [showPassword, setShowPassword] = useState(false);
  const { theme, toggle } = useTheme();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";

  const next =
    actionData && "next" in actionData
      ? safeNext(String(actionData.next))
      : loaderData.next;
  const error =
    actionData && "error" in actionData ? String(actionData.error) : null;

  return (
    <main className="relative flex min-h-screen items-center justify-center px-4 py-12">
      <div className="absolute top-4 right-4">
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={toggle}
          aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </Button>
      </div>

      <div className="glass-panel w-full max-w-sm p-6 sm:p-8">
        <div className="mb-6 flex flex-col items-center text-center">
          <BrandMark size={46} />
          <h1 className="mt-4 text-2xl font-bold tracking-tight text-foreground">
            UniRoute
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            AI Gateway Admin · Sign in to continue
          </p>
        </div>

        <Form method="post" className="flex flex-col gap-4">
          <input type="hidden" name="next" value={next} />
          <div>
            <Label htmlFor="password">Admin password</Label>
            <div className="relative">
              <Lock
                size={15}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                required
                autoFocus
                autoComplete="current-password"
                invalid={Boolean(error)}
                placeholder="Enter dashboard password"
                className="pl-9 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute top-1/2 right-2 -translate-y-1/2 cursor-pointer rounded-md p-1 text-muted-foreground transition-colors hover:bg-glass-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {error ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs font-medium text-danger"
            >
              <AlertCircle size={15} className="mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          ) : null}

          <Button type="submit" className="mt-1 w-full" disabled={submitting}>
            {submitting ? <Spinner size={15} /> : null}
            {submitting ? "Signing in…" : "Sign in"}
          </Button>
        </Form>
      </div>
    </main>
  );
}

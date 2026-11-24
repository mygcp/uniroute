import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  redirect,
  Scripts,
  ScrollRestoration,
  useLocation,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Home, RefreshCw } from "lucide-react";
import type { Route } from "./+types/root";
import { Header } from "./components/header";
import { Sidebar } from "./components/sidebar";
import { ToastProvider } from "./components/ui/toast";
import { Button, buttonClass } from "./components/ui/button";
import { ThemeProvider } from "./hooks/use-theme";
import { getSessionToken, isValid } from "./.server/auth";
import "./app.css";

export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap",
  },
];

export async function loader({ request }: Route.LoaderArgs) {
  const { pathname } = new URL(request.url);
  if (pathname === "/login" || pathname.startsWith("/v1/")) {
    return {};
  }
  if (isValid(getSessionToken(request))) {
    return {};
  }
  const next = encodeURIComponent(pathname);
  return redirect(`/login?next=${next}`);
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <html lang="en" suppressHydrationWarning>
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <Meta />
          <Links />
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var t=localStorage.getItem("uniroute-theme");if(t==="light"){document.documentElement.classList.add("light")}}catch(e){}})();`,
            }}
          />
        </head>
        <body>
          {children}
          <ScrollRestoration />
          <Scripts />
        </body>
      </html>
    </ThemeProvider>
  );
}

function AppShell() {
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const pageRef = useRef<HTMLDivElement>(null);
  const prevPath = useRef(pathname);

  useEffect(() => {
    if (prevPath.current === pathname) return;
    prevPath.current = pathname;
    const el = pageRef.current;
    if (!el) return;
    el.classList.remove("animate-page-in");
    void el.offsetHeight;
    el.classList.add("animate-page-in");
  }, [pathname]);

  if (pathname === "/login") {
    return <Outlet />;
  }
  return (
    <div className="flex min-h-screen">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <main className="mx-auto w-full max-w-[1440px] flex-1 overflow-x-clip px-3 py-5 sm:px-5 md:px-7 md:py-6">
          <div ref={pageRef} className="animate-page-in">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AppShell />
    </ToastProvider>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let status = "Error";
  let title = "Something went wrong";
  let details = "An unexpected error occurred while rendering this page.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    status = String(error.status);
    title = error.status === 404 ? "Page not found" : error.statusText || "Request error";
    details =
      error.status === 404
        ? "The page you are looking for doesn't exist or may have been moved."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="glass-panel w-full max-w-lg p-6 sm:p-8">
        <div className="mb-4 flex items-center gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-danger/25 bg-danger/10 text-danger">
            <AlertTriangle size={22} />
          </div>
          <div>
            <span className="inline-block rounded-full border border-danger/25 bg-danger/10 px-2 py-0.5 font-mono text-xs font-semibold text-danger">
              {status}
            </span>
            <h1 className="mt-1 text-lg font-bold text-foreground">{title}</h1>
          </div>
        </div>
        <p className="text-sm leading-relaxed text-muted-foreground">{details}</p>
        {stack && (
          <details className="mt-4 rounded-lg border border-glass-border bg-surface-2 p-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Stack trace
            </summary>
            <pre className="slim-scroll mt-2 max-h-60 overflow-auto font-mono text-xs text-foreground">
              <code>{stack}</code>
            </pre>
          </details>
        )}
        <div className="mt-6 flex flex-wrap gap-2">
          <Link to="/home" className={buttonClass("primary", "md")}>
            <Home size={15} />
            Back to Dashboard
          </Link>
          <Button
            variant="outline"
            onClick={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
          >
            <RefreshCw size={15} />
            Reload
          </Button>
        </div>
      </div>
    </main>
  );
}

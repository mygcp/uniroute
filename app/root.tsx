import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  redirect,
  Scripts,
  ScrollRestoration,
  useLocation,
  useNavigation,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/root";
import { Header } from "./components/header";
import { Sidebar } from "./components/sidebar";
import { ToastProvider } from "./components/ui/toast";
import { ThemeProvider, useTheme } from "./hooks/use-theme";
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
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
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
      <ThemedHtml>{children}</ThemedHtml>
    </ThemeProvider>
  );
}

function ThemedHtml({ children }: { children: React.ReactNode }) {
  const { theme } = useTheme();
  return (
    <html lang="en" className={theme === "light" ? "light" : undefined} suppressHydrationWarning>
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
  );
}

function AppShell() {
  const { pathname } = useLocation();
  const navigation = useNavigation();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const pageRef = useRef<HTMLDivElement>(null);
  const vtSupported = useRef(false);
  const resolveUpdate = useRef<(() => void) | null>(null);
  const prevPath = useRef(pathname);

  // Detect View Transitions support once, after hydration (avoids an SSR/hydration mismatch).
  useEffect(() => {
    vtSupported.current =
      typeof document !== "undefined" &&
      typeof document.startViewTransition === "function";
  }, []);

  // Start a view transition when a client-side navigation begins. The update
  // promise only resolves once the new page has committed (state -> "idle"),
  // mirroring how React Router itself times document.startViewTransition().
  // Login/logout keep full-page navigation, so skip transitions around /login.
  useEffect(() => {
    if (navigation.state !== "loading") return;
    if (!vtSupported.current) return;
    if (pathname === "/login" || navigation.location?.pathname === "/login") return;
    // Resolve any previously pending transition so a quick successive
    // navigation can't leave it hanging (which would freeze the UI).
    const prev = resolveUpdate.current;
    resolveUpdate.current = null;
    prev?.();
    document.startViewTransition(
      () =>
        new Promise<void>((r) => {
          resolveUpdate.current = r;
        }),
    );
  }, [navigation.state, pathname, navigation.location?.pathname]);

  useEffect(() => {
    if (navigation.state !== "idle") return;
    const r = resolveUpdate.current;
    if (!r) return;
    resolveUpdate.current = null;
    r();
  }, [navigation.state]);

  // Fallback for browsers without View Transitions: replay the CSS fade-in on
  // each route change. With View Transitions available the API drives the
  // cross-fade instead, so the class-based animation must not replay.
  useEffect(() => {
    if (vtSupported.current) return;
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
    <div className="flex min-h-screen bg-background">
      <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onMenuClick={() => setSidebarOpen(true)} />
        <main className="flex-1 overflow-x-hidden px-3 py-4 sm:px-4 md:p-6">
          <div ref={pageRef} className="animate-page-in view-transition-page">
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
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="pt-16 p-4 container mx-auto">
      <h1>{message}</h1>
      <p>{details}</p>
      {stack && (
        <pre className="w-full p-4 overflow-x-auto">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
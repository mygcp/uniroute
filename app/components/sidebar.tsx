import { useEffect } from "react";
import { Form, Link, NavLink } from "react-router";
import {
  Home,
  Plug,
  FileArchive,
  KeySquare,
  Link2,
  FolderOpen,
  LogOut,
  ScrollText,
  ShieldCheck,
  TrendingUp,
  Network,
  Bot,
  Cable,
  Globe,
  X,
} from "lucide-react";
import { Button } from "./ui/button";

const CORE_ITEMS = [
  { to: "/home", label: "Dashboard", icon: Home, end: true },
  { to: "/providers", label: "Providers", icon: Plug },
  { to: "/api-manager", label: "API Keys", icon: KeySquare },
  { to: "/combo", label: "Model Combos", icon: Link2 },
  { to: "/proxies", label: "Proxies", icon: Network },
  { to: "/compression", label: "Compression", icon: FileArchive },
  { to: "/prompt-guard", label: "Prompt Guard", icon: ShieldCheck },
];

const TOOLS_ITEMS = [
  { to: "/tunnels", label: "Tunneling", icon: Globe },
  { to: "/mcp", label: "MCP Server", icon: Cable },
  { to: "/agents", label: "AI Agents", icon: Bot },
];

const OBSERVABILITY_ITEMS = [
  { to: "/analytics/usage", label: "Usage Analytics", icon: TrendingUp, end: true },
  { to: "/logs", label: "Request Logs", icon: ScrollText, end: true },
  { to: "/logs/proxy", label: "Proxy Logs", icon: FolderOpen },
];

function linkClass({ isActive }: { isActive: boolean }): string {
  return [
    "group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all",
    isActive
      ? "bg-primary/12 text-primary shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--primary)_25%,transparent)]"
      : "text-muted-foreground hover:bg-glass-hover hover:text-foreground",
  ].join(" ");
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/75">
      {children}
    </p>
  );
}

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <div
      style={{ width: size, height: size }}
      className="relative grid shrink-0 place-items-center rounded-lg border border-primary-solid-border bg-primary-solid text-primary-foreground"
    >
      <svg
        width={Math.round(size * 0.56)}
        height={Math.round(size * 0.56)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="5" cy="12" r="2.5" />
        <circle cx="19" cy="6" r="2.5" />
        <circle cx="19" cy="18" r="2.5" />
        <path d="M7.5 12h4.2c1.8 0 2.5-1.2 3.2-3.2L16.5 6" />
        <path d="M7.5 12h4.2c1.8 0 2.5 1.2 3.2 3.2L16.5 18" />
      </svg>
    </div>
  );
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      to="/home"
      onClick={onNavigate}
      className="flex items-center gap-3 px-4 py-4 transition-opacity hover:opacity-90"
    >
      <BrandMark size={34} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-base font-bold tracking-tight text-foreground">
            UniRoute
          </span>
          <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
            v1.1
          </span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          AI Gateway Admin
        </p>
      </div>
    </Link>
  );
}

function NavGroup({
  label,
  items,
  onNavigate,
}: {
  label?: string;
  items: { to: string; label: string; icon: typeof Home; end?: boolean }[];
  onNavigate?: () => void;
}) {
  return (
    <div className={label ? "pt-4" : ""}>
      {label ? <SectionLabel>{label}</SectionLabel> : null}
      <div className="space-y-0.5">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              prefetch="intent"
              className={linkClass}
              end={item.end}
              onClick={onNavigate}
            >
              {({ isActive }) => (
                <>
                  {isActive ? (
                    <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-primary" />
                  ) : null}
                  <Icon
                    size={16}
                    className={
                      isActive
                        ? "shrink-0 text-primary"
                        : "shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                    }
                  />
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav aria-label="Main navigation" className="slim-scroll flex-1 overflow-y-auto px-3 py-3">
        <NavGroup items={CORE_ITEMS} onNavigate={onNavigate} />
        <NavGroup label="Integrations" items={TOOLS_ITEMS} onNavigate={onNavigate} />
        <NavGroup label="Observability" items={OBSERVABILITY_ITEMS} onNavigate={onNavigate} />
      </nav>

      <div className="border-t border-border p-3">
        <Form method="post" action="/logout">
          <Button
            type="submit"
            variant="ghost"
            className="w-full justify-start px-3 text-muted-foreground hover:text-danger"
          >
            <LogOut size={16} />
            Sign out
          </Button>
        </Form>
      </div>
    </>
  );
}

type SidebarProps = {
  open: boolean;
  onClose: () => void;
};

export function Sidebar({ open, onClose }: SidebarProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, onClose]);

  return (
    <>
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="border-b border-border">
          <Brand />
        </div>
        <SidebarContent />
      </aside>

      <div
        inert={!open}
        className={`fixed inset-0 z-50 transition-opacity duration-200 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!open}
      >
        <div
          className="absolute inset-0 bg-black/65 backdrop-blur-[2px]"
          onClick={onClose}
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border-strong bg-surface shadow-2xl transition-transform duration-200 ease-out ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-border pr-3">
            <Brand onNavigate={onClose} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close menu"
              className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <SidebarContent onNavigate={onClose} />
        </aside>
      </div>
    </>
  );
}

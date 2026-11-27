import { useEffect, useState } from "react";
import { Form, Link, NavLink } from "react-router";
import {
  ArrowUpCircle,
  Bot,
  Cable,
  FileArchive,
  FolderOpen,
  Globe,
  Home,
  KeySquare,
  Link2,
  LogOut,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  ScrollText,
  ShieldCheck,
  TrendingUp,
  X,
} from "lucide-react";
import pkg from "../../package.json";
import { Button } from "./ui/button";

const APP_VERSION = pkg.version || "1.1.0";

type NavItem = {
  to: string;
  label: string;
  icon: typeof Home;
  end?: boolean;
};

const ROUTING_ITEMS: NavItem[] = [
  { to: "/home", label: "Dashboard", icon: Home, end: true },
  { to: "/providers", label: "Providers", icon: Plug },
  { to: "/api-manager", label: "API Keys", icon: KeySquare },
  { to: "/combo", label: "Model Combos", icon: Link2 },
  { to: "/proxies", label: "Proxies", icon: Network },
];

const CONTROLS_ITEMS: NavItem[] = [
  { to: "/compression", label: "Compression", icon: FileArchive },
  { to: "/prompt-guard", label: "Prompt Guard", icon: ShieldCheck },
];

const ACCESS_ITEMS: NavItem[] = [
  { to: "/tunnels", label: "Tunneling", icon: Globe },
  { to: "/mcp", label: "MCP Server", icon: Cable },
  { to: "/agents", label: "AI Agents", icon: Bot },
];

const OBSERVABILITY_ITEMS: NavItem[] = [
  { to: "/analytics/usage", label: "Usage Analytics", icon: TrendingUp, end: true },
  { to: "/logs", label: "Request Logs", icon: ScrollText, end: true },
  { to: "/logs/proxy", label: "Proxy Logs", icon: FolderOpen },
];

const SYSTEM_ITEMS: NavItem[] = [
  { to: "/updates", label: "Updates", icon: ArrowUpCircle, end: true },
];

function linkClass(collapsed: boolean) {
  return ({ isActive }: { isActive: boolean }): string =>
    [
      "group relative flex min-h-[44px] md:min-h-[36px] items-center rounded-md text-sm font-medium transition-colors",
      collapsed ? "justify-center px-2" : "gap-2.5 px-3",
      isActive
        ? "border border-primary/40 bg-primary/14 font-semibold text-foreground"
        : "border border-transparent text-muted-foreground hover:bg-surface-2 hover:text-foreground",
    ].join(" ");
}

function SectionLabel({ children, collapsed }: { children: string; collapsed: boolean }) {
  if (collapsed) {
    return <div className="mx-2 my-2 border-t border-border" aria-hidden="true" />;
  }
  return (
    <p className="px-3 pb-1 pt-1 text-xs font-medium text-muted-foreground">
      {children}
    </p>
  );
}

export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <div
      style={{ width: size, height: size }}
      className="relative grid shrink-0 place-items-center rounded-md border border-primary-solid-border bg-primary-solid text-primary-foreground"
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

function Brand({
  collapsed,
  onNavigate,
}: {
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      to="/home"
      onClick={onNavigate}
      aria-label="UniRoute Dashboard"
      className={`flex items-center transition-opacity hover:opacity-90 ${
        collapsed ? "justify-center px-2 py-3.5" : "gap-3 px-4 py-3.5"
      }`}
    >
      <BrandMark size={32} />
      {!collapsed ? (
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-bold tracking-tight text-foreground">
              UniRoute
            </span>
            <span className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted-foreground">
              v{APP_VERSION}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">AI Gateway</p>
        </div>
      ) : null}
    </Link>
  );
}

function NavGroup({
  label,
  items,
  collapsed = false,
  onNavigate,
}: {
  label?: string;
  items: NavItem[];
  collapsed?: boolean;
  onNavigate?: () => void;
}) {
  return (
    <div className={label ? "pt-3" : ""}>
      {label ? <SectionLabel collapsed={collapsed}>{label}</SectionLabel> : null}
      <div className="space-y-0.5">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              prefetch="intent"
              className={linkClass(collapsed)}
              end={item.end}
              title={collapsed ? item.label : undefined}
              aria-label={collapsed ? item.label : undefined}
              onClick={onNavigate}
            >
              {({ isActive }) => (
                <>
                  {isActive ? (
                    <span
                      aria-hidden="true"
                      className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-primary"
                    />
                  ) : null}
                  <Icon
                    size={16}
                    aria-hidden="true"
                    className={
                      isActive
                        ? "shrink-0 text-primary"
                        : "shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                    }
                  />
                  {!collapsed ? <span className="truncate">{item.label}</span> : null}
                </>
              )}
            </NavLink>
          );
        })}
      </div>
    </div>
  );
}

function SidebarContent({
  collapsed = false,
  onToggleCollapse,
  onNavigate,
}: {
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  onNavigate?: () => void;
}) {
  return (
    <>
      <nav aria-label="Main navigation" className="slim-scroll flex-1 overflow-y-auto px-2.5 py-3">
        <NavGroup items={ROUTING_ITEMS} collapsed={collapsed} onNavigate={onNavigate} />
        <NavGroup label="Controls" items={CONTROLS_ITEMS} collapsed={collapsed} onNavigate={onNavigate} />
        <NavGroup label="Access" items={ACCESS_ITEMS} collapsed={collapsed} onNavigate={onNavigate} />
        <NavGroup label="Observability" items={OBSERVABILITY_ITEMS} collapsed={collapsed} onNavigate={onNavigate} />
        <NavGroup label="System" items={SYSTEM_ITEMS} collapsed={collapsed} onNavigate={onNavigate} />
      </nav>

      <div className="space-y-1.5 border-t border-border p-2.5">
        {onToggleCollapse ? (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`flex min-h-[36px] w-full items-center rounded-md border border-transparent px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground ${
              collapsed ? "justify-center px-2" : "gap-2.5"
            }`}
          >
            {collapsed ? (
              <PanelLeftOpen size={15} aria-hidden="true" />
            ) : (
              <>
                <PanelLeftClose size={15} aria-hidden="true" />
                <span>Collapse rail</span>
              </>
            )}
          </button>
        ) : null}

        <Form method="post" action="/logout">
          <Button
            type="submit"
            variant="ghost"
            title={collapsed ? "Sign out" : undefined}
            aria-label={collapsed ? "Sign out" : undefined}
            className={`w-full text-muted-foreground hover:text-danger ${
              collapsed ? "justify-center px-2" : "justify-start px-3"
            }`}
          >
            <LogOut size={16} aria-hidden="true" />
            {!collapsed ? <span>Sign out</span> : null}
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
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("uniroute-sidebar-collapsed") === "1");
    } catch {
      // ignore storage errors
    }
  }, []);

  const toggleCollapse = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("uniroute-sidebar-collapsed", next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  };

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
      <aside
        className={`sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 md:flex ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <div className="border-b border-border">
          <Brand collapsed={collapsed} />
        </div>
        <SidebarContent collapsed={collapsed} onToggleCollapse={toggleCollapse} />
      </aside>

      <div
        inert={!open}
        className={`fixed inset-0 z-50 transition-opacity duration-150 md:hidden ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
        aria-hidden={!open}
      >
        <div
          className="absolute inset-0 bg-black/65"
          onClick={onClose}
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
          className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-border-strong bg-surface shadow-2xl transition-transform duration-150 ease-out ${
            open ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="flex items-center justify-between border-b border-border pr-2">
            <Brand onNavigate={onClose} />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close navigation menu"
              className="grid min-h-[44px] min-w-[44px] place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground"
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

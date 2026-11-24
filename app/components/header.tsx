import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  Bot,
  Cable,
  ChevronRight,
  FileArchive,
  FolderOpen,
  Globe,
  Home,
  KeySquare,
  Link2,
  Menu,
  Moon,
  Network,
  Plug,
  Plus,
  ScrollText,
  Search,
  Sun,
  TrendingUp,
  X,
} from "lucide-react";
import { useTheme } from "../hooks/use-theme";
import { Button } from "./ui/button";
import { Tooltip } from "./ui/tooltip";

type Crumb = { label: string; to?: string };

const SEGMENT_LABELS: Record<string, string> = {
  home: "Dashboard",
  providers: "Providers",
  "api-manager": "API Keys",
  create: "Create",
  groups: "Groups",
  templates: "Templates",
  combo: "Model Combos",
  proxies: "Proxies",
  compression: "Compression",
  tunnels: "Tunneling",
  mcp: "MCP Server",
  agents: "AI Agents",
  logs: "Request Logs",
  proxy: "Proxy Logs",
  analytics: "Analytics",
  usage: "Usage Analytics",
};

function buildBreadcrumbs(pathname: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0 || (parts.length === 1 && parts[0] === "home")) {
    return [{ label: "Dashboard" }];
  }
  if (parts[0] === "analytics" && parts[1] === "usage") {
    return [{ label: "Usage Analytics" }];
  }
  if (parts[0] === "logs" && parts[1] === "proxy") {
    return [{ label: "Logs", to: "/logs" }, { label: "Proxy Logs" }];
  }
  const crumbs: Crumb[] = [];
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    acc += `/${seg}`;
    const isLast = i === parts.length - 1;
    const label = SEGMENT_LABELS[seg] ?? decodeURIComponent(seg);
    crumbs.push(isLast ? { label } : { label, to: acc });
  }
  return crumbs;
}

type CommandItem = {
  id: string;
  label: string;
  group: "Pages" | "Quick Actions";
  keywords?: string;
  icon: typeof Home;
  to?: string;
  action?: "theme";
};

const COMMANDS: CommandItem[] = [
  { id: "home", label: "Dashboard", group: "Pages", keywords: "home overview stats", icon: Home, to: "/home" },
  { id: "providers", label: "Providers", group: "Pages", keywords: "openai anthropic gemini models", icon: Plug, to: "/providers" },
  { id: "api-manager", label: "API Keys", group: "Pages", keywords: "client keys auth budget", icon: KeySquare, to: "/api-manager" },
  { id: "combo", label: "Model Combos", group: "Pages", keywords: "fallback routing chain", icon: Link2, to: "/combo" },
  { id: "proxies", label: "Proxies", group: "Pages", keywords: "socks5 http pool outbound", icon: Network, to: "/proxies" },
  { id: "compression", label: "Compression", group: "Pages", keywords: "rtk caveman prompt", icon: FileArchive, to: "/compression" },
  { id: "tunnels", label: "Tunneling", group: "Pages", keywords: "cloudflared ngrok frpc bore domain public url", icon: Globe, to: "/tunnels" },
  { id: "mcp", label: "MCP Server", group: "Pages", keywords: "model context protocol tools", icon: Cable, to: "/mcp" },
  { id: "agents", label: "AI Agents", group: "Pages", keywords: "claude codex opencode cli", icon: Bot, to: "/agents" },
  { id: "analytics", label: "Usage Analytics", group: "Pages", keywords: "tokens cost chart breakdown", icon: TrendingUp, to: "/analytics/usage" },
  { id: "logs", label: "Request Logs", group: "Pages", keywords: "live stream traffic debug", icon: ScrollText, to: "/logs" },
  { id: "proxy-logs", label: "Proxy Logs", group: "Pages", keywords: "outbound errors", icon: FolderOpen, to: "/logs/proxy" },
  { id: "new-key", label: "Create New API Key", group: "Quick Actions", keywords: "add client key", icon: Plus, to: "/api-manager/create" },
  { id: "new-proxy", label: "Add Outbound Proxy", group: "Quick Actions", keywords: "create proxy", icon: Plus, to: "/proxies/create" },
  { id: "key-groups", label: "Manage Key Groups", group: "Quick Actions", keywords: "quotas groups", icon: KeySquare, to: "/api-manager/groups" },
  { id: "key-templates", label: "Manage Key Templates", group: "Quick Actions", keywords: "presets", icon: KeySquare, to: "/api-manager/templates" },
  { id: "toggle-theme", label: "Toggle Dark / Light Theme", group: "Quick Actions", keywords: "appearance mode", icon: Sun, action: "theme" },
];

function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const { toggle } = useTheme();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter(
      (c) =>
        c.label.toLowerCase().includes(q) ||
        (c.keywords && c.keywords.toLowerCase().includes(q)),
    );
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const run = (item: CommandItem) => {
    onClose();
    if (item.action === "theme") {
      toggle();
    } else if (item.to) {
      navigate(item.to);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-start justify-center bg-black/65 px-4 pt-[14vh] backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Quick navigation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog-pop w-full max-w-lg overflow-hidden rounded-2xl border border-border-strong bg-surface shadow-2xl">
        <div className="flex items-center gap-2.5 border-b border-border bg-surface-2/40 px-4 py-3">
          <Search size={16} className="shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, Math.max(0, filtered.length - 1)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && filtered[active]) {
                e.preventDefault();
                run(filtered[active]);
              }
            }}
            placeholder="Jump to page or action..."
            className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="hidden rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
            ESC
          </kbd>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close quick navigation"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:hidden"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>

        <div className="slim-scroll max-h-80 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No matching commands.
            </p>
          ) : (
            filtered.map((item, i) => {
              const Icon = item.icon;
              const isSelected = i === active;
              return (
                <button
                  key={item.id}
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(item)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    isSelected
                      ? "bg-primary/12 text-primary"
                      : "text-foreground hover:bg-surface-2"
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon size={15} className={isSelected ? "text-primary" : "text-muted-foreground"} aria-hidden="true" />
                    <span className="font-medium">{item.label}</span>
                  </span>
                  <span className="text-[11px] text-muted-foreground">{item.group}</span>
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center justify-between border-t border-border bg-surface-2/40 px-4 py-2 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-3">
            <span>↑↓ Navigate</span>
            <span>↵ Open</span>
          </div>
          <span>ESC Close</span>
        </div>
      </div>
    </div>
  );
}

export function Header({ onMenuClick }: { onMenuClick?: () => void }) {
  const { theme, toggle } = useTheme();
  const { pathname } = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const crumbs = useMemo(() => buildBreadcrumbs(pathname), [pathname]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const themeLabel = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";

  return (
    <>
      <header className="sticky top-0 z-40 flex h-14 items-center justify-between gap-3 border-b border-border bg-surface/95 px-3 backdrop-blur-md sm:px-5 md:px-7">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button
            type="button"
            onClick={onMenuClick}
            aria-label="Open navigation menu"
            size="icon"
            variant="outline"
            className="md:hidden"
          >
            <Menu size={18} />
          </Button>

          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
            {crumbs.map((c, idx) => (
              <span key={`${c.label}-${idx}`} className="flex min-w-0 items-center gap-1.5">
                {idx > 0 ? (
                  <ChevronRight size={14} className="shrink-0 text-muted-foreground/60" />
                ) : null}
                {c.to ? (
                  <Link
                    to={c.to}
                    prefetch="intent"
                    className="truncate text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {c.label}
                  </Link>
                ) : (
                  <span className="truncate font-medium text-foreground">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label="Quick navigation"
            className="flex h-8 items-center gap-2 rounded-lg border border-border bg-surface-2/70 px-2.5 text-xs text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 sm:w-52 sm:justify-between"
          >
            <span className="flex items-center gap-1.5">
              <Search size={13} aria-hidden="true" />
              <span className="hidden sm:inline">Quick jump...</span>
            </span>
            <kbd className="hidden rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground sm:inline-block">
              Ctrl K
            </kbd>
          </button>

          <Tooltip label={themeLabel} side="bottom" align="end">
            <Button
              type="button"
              onClick={toggle}
              aria-label={themeLabel}
              size="icon"
              variant="outline"
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </Button>
          </Tooltip>
        </div>
      </header>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </>
  );
}

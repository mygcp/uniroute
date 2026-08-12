import { Form, NavLink } from "react-router";
import {
  Home,
  Plug,
  FileArchive,
  KeyRound,
  KeySquare,
  Link2,
  FolderOpen,
  LogOut,
  ScrollText,
  TrendingUp,
  Network,
  X,
} from "lucide-react";

const NAV_ITEMS = [
  { to: "/home", label: "Home", icon: Home },
  { to: "/providers", label: "Provider", icon: Plug },
  { to: "/compression", label: "Compression", icon: FileArchive },
  { to: "/api", label: "API", icon: KeyRound },
  { to: "/api-manager", label: "API Manager", icon: KeySquare },
  { to: "/combo", label: "Combo", icon: Link2 },
  { to: "/proxies", label: "Proxies", icon: Network },
];

// Grouped under "Monitoring" — request + proxy log viewers.
const MONITORING_ITEMS = [
  { to: "/logs", label: "Request Logs", icon: ScrollText },
  { to: "/logs/proxy", label: "Proxy Logs", icon: FolderOpen },
];

// Grouped under "Analytics" — usage and charts.
const ANALYTICS_ITEMS = [
  { to: "/analytics/usage", label: "Usage", icon: TrendingUp },
];

function linkClass({ isActive }: { isActive: boolean }): string {
  return [
    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
    isActive
      ? "bg-blue-600 text-white"
      : "text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800",
  ].join(" ");
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <>
      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={linkClass}
              end={item.to === "/home"}
              onClick={onNavigate}
            >
              <Icon size={16} />
              {item.label}
            </NavLink>
          );
        })}

        <div className="pt-3">
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Monitoring
          </p>
          {MONITORING_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={linkClass}
                end={item.to === "/logs"}
                onClick={onNavigate}
              >
                <Icon size={16} />
                {item.label}
              </NavLink>
            );
          })}
        </div>

        <div className="pt-3">
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
            Analytics
          </p>
          {ANALYTICS_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={linkClass}
                end={item.to === "/analytics/usage"}
                onClick={onNavigate}
              >
                <Icon size={16} />
                {item.label}
              </NavLink>
            );
          })}
        </div>
      </nav>

      <div className="border-t border-gray-200 p-3 dark:border-gray-800">
        <Form method="post" action="/logout">
          <button
            type="submit"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-red-50 hover:text-red-600 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-red-950 dark:hover:text-red-400"
          >
            <LogOut size={16} />
            Logout
          </button>
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
  return (
    <>
      <aside className="hidden w-64 shrink-0 flex-col border-r border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900 md:flex">
        <div className="border-b border-gray-200 px-4 py-4 dark:border-gray-800">
          <h1 className="text-lg font-bold text-gray-900 dark:text-white">UniRoute</h1>
          <p className="text-xs text-gray-500 dark:text-gray-400">AI Gateway Admin</p>
        </div>
        <SidebarContent />
      </aside>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-gray-950/50" onClick={onClose} />
          <aside className="absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-gray-200 bg-white shadow-xl dark:border-gray-800 dark:bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-200 px-4 py-4 dark:border-gray-800">
              <div>
                <h1 className="text-lg font-bold text-gray-900 dark:text-white">UniRoute</h1>
                <p className="text-xs text-gray-500 dark:text-gray-400">AI Gateway Admin</p>
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close menu"
                className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                <X size={20} />
              </button>
            </div>
            <SidebarContent onNavigate={onClose} />
          </aside>
        </div>
      ) : null}
    </>
  );
}

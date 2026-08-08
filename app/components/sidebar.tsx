import { Form, NavLink } from "react-router";

const NAV_ITEMS = [
  { to: "/home", label: "🏠 Home" },
  { to: "/providers", label: "🔌 Provider" },
  { to: "/compression", label: "🗜️ Compression" },
  { to: "/api", label: "🔑 API" },
  { to: "/combo", label: "🔗 Combo" },
  { to: "/proxy", label: "🌐 Proxy" },
];

const LOGS_ITEMS = [
  { to: "/logs/requests", label: "Request Logs" },
  { to: "/logs/proxy", label: "Proxy Logs" },
];

function linkClass({ isActive }: { isActive: boolean }): string {
  return [
    "block rounded-lg px-3 py-2 text-sm font-medium transition-colors",
    isActive
      ? "bg-blue-600 text-white"
      : "text-gray-700 hover:bg-gray-100",
  ].join(" ");
}

export function Sidebar() {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-4 py-4">
        <h1 className="text-lg font-bold text-gray-900">UniRoute</h1>
        <p className="text-xs text-gray-500">AI Gateway Admin</p>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto p-3">
        {NAV_ITEMS.map((item) => (
          <NavLink key={item.to} to={item.to} className={linkClass} end={item.to === "/home"}>
            {item.label}
          </NavLink>
        ))}

        <div className="pt-3">
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-gray-400">
            📋 Logs
          </p>
          {LOGS_ITEMS.map((item) => (
            <NavLink key={item.to} to={item.to} className={linkClass}>
              {item.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <div className="border-t border-gray-200 p-3">
        <Form method="post" action="/logout">
          <button
            type="submit"
            className="w-full rounded-lg bg-gray-100 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-red-50 hover:text-red-600"
          >
            🚪 Logout
          </button>
        </Form>
      </div>
    </aside>
  );
}
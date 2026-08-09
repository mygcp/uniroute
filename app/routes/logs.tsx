import { NavLink, Outlet } from "react-router";

export function meta() {
  return [{ title: "Logs — UniRoute" }];
}

function tabClass({ isActive }: { isActive: boolean }): string {
  return [
    "rounded-lg px-3 py-1.5 text-sm font-medium",
    isActive ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200",
  ].join(" ");
}

export default function Logs() {
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold">📋 Logs</h1>
      <nav className="tabs-scroll mb-4">
        <NavLink to="/logs/requests" className={tabClass}>
          Request Logs
        </NavLink>
        <NavLink to="/logs/proxy" className={tabClass}>
          Proxy Logs
        </NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
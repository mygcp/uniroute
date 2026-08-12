import { Outlet } from "react-router";

/**
 * Layout for the /logs section. Request logs live at `/logs`
 * (logs._index), proxy logs at `/logs/proxy` (logs.proxy).
 */
export function meta() {
  return [{ title: "Monitoring — UniRoute" }];
}

export default function LogsLayout() {
  return <Outlet />;
}
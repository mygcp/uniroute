import { Outlet } from "react-router";

/**
 * Layout untuk /api-manager/*. Halaman dashboard ada di api-manager._index.tsx;
 * create/detail/templates/groups/export dirender via <Outlet/>.
 */
export default function ApiManagerLayout() {
  return <Outlet />;
}
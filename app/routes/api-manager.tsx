import { Outlet } from "react-router";

/**
 * Layout for /api-manager/* routes; child pages render via <Outlet/>.
 */
export default function ApiManagerLayout() {
	return <Outlet />;
}

import type { Route } from "./+types/api-manager.export";
import { requireSession } from "../.server/auth";
import { applyBulk, exportKeysCsv } from "../.server/key-bulk";

export function loader({ request }: Route.LoaderArgs) {
	const denied = requireSession(request);
	if (denied) return denied;
	const url = new URL(request.url);
	const status = url.searchParams.get("status") ?? "any";
	const createdBefore = url.searchParams.get("created_before");
	const format = url.searchParams.get("format") === "json" ? "json" : "csv";
	const ids = (url.searchParams.get("ids") ?? "")
		.split(",")
		.map((s) => Number(s))
		.filter((n) => n > 0);

	const res = applyBulk(
		{
			status: status === "any" ? undefined : (status as never),
			createdBefore: createdBefore
				? new Date(createdBefore).getTime() / 1000
				: undefined,
		},
		"export",
		{},
		ids.length > 0 ? ids : undefined,
	);

	const keys = res.exported ?? [];
	const body =
		format === "json" ? JSON.stringify(keys, null, 2) : exportKeysCsv(keys);
	const ext = format === "json" ? "json" : "csv";
	return new Response(body, {
		headers: {
			"content-type": format === "json" ? "application/json" : "text/csv",
			"content-disposition": `attachment; filename="api-keys.${ext}"`,
		},
	});
}

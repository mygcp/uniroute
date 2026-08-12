import type { Route } from "./+types/analytics.usage";
import { getUsageLast7Days } from "../.server/stats";
import { UsageChart } from "../components/usage-chart";

export function meta() {
  return [{ title: "Usage — UniRoute" }];
}

export function loader() {
  return { usage: getUsageLast7Days() };
}

export default function AnalyticsUsage({ loaderData }: Route.ComponentProps) {
  return (
    <div>
      <h1 className="mb-4 text-xl font-bold text-gray-900 dark:text-white">Usage</h1>
      <UsageChart data={loaderData.usage} />
    </div>
  );
}
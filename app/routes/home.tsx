import type { Route } from "./+types/home";
import { getStats, getUsageLast7Days } from "../.server/stats";
import { StatCard } from "../components/stat-card";
import { UsageChart } from "../components/usage-chart";

export function meta() {
  return [{ title: "Home — UniRoute" }];
}

export function loader() {
  return { stats: getStats(), usage: getUsageLast7Days() };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { stats, usage } = loaderData;
  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">🏠 Dashboard</h1>
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Requests" value={stats.total} />
        <StatCard
          title="Success Rate"
          value={stats.successRate}
          suffix="%"
          accent="bg-green-500"
        />
        <StatCard
          title="Avg Latency"
          value={stats.avgLatency}
          suffix="ms"
          accent="bg-amber-500"
        />
        <StatCard
          title="Active Providers"
          value={stats.activeProviders}
          accent="bg-violet-500"
        />
      </div>
      <UsageChart data={usage} />
    </div>
  );
}
import { Home as HomeIcon } from "lucide-react";
import type { Route } from "./+types/home";
import { getStats, getUsageLast7Days } from "../.server/stats";
import { StatCard } from "../components/ui/stat-card";
import { PageHeader } from "../components/ui/page-header";
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
      <PageHeader title="Dashboard" icon={<HomeIcon size={20} />} />
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard title="Total Requests" value={stats.total} />
        <StatCard
          title="Success Rate"
          value={stats.successRate}
          suffix="%"
          accent="bg-success"
        />
        <StatCard
          title="Avg Latency"
          value={stats.avgLatency}
          suffix="ms"
          accent="bg-warning"
        />
        <StatCard
          title="Active Providers"
          value={stats.activeProviders}
          accent="bg-info"
        />
      </div>
      <UsageChart data={usage} />
    </div>
  );
}
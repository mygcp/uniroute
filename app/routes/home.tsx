import { Home as HomeIcon } from "lucide-react";
import type { Route } from "./+types/home";
import {
  getStats,
  getUsageLast7Days,
  getUsageWeekSummary,
} from "../.server/stats";
import { StatCard } from "../components/ui/stat-card";
import { PageHeader } from "../components/ui/page-header";
import { UsageChart } from "../components/usage-chart";

export function meta() {
  return [{ title: "Home — UniRoute" }];
}

export function loader() {
  return {
    stats: getStats(),
    usage: getUsageLast7Days(),
    week: getUsageWeekSummary(),
  };
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { stats, usage, week } = loaderData;
  // 17.571ms sulit dibaca → tampilkan dalam detik bila ≥ 1s.
  const latency =
    stats.avgLatency >= 1000
      ? { value: (stats.avgLatency / 1000).toFixed(1), suffix: "s" }
      : { value: String(stats.avgLatency), suffix: "ms" };
  return (
    <div>
      <PageHeader title="Dashboard" icon={<HomeIcon size={20} />} />
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Requests"
          value={stats.total}
          subline={`${stats.today} today`}
        />
        <StatCard
          title="Success Rate"
          value={stats.successRate}
          suffix="%"
          accent="bg-success"
          subline={`${stats.success}/${stats.total} requests OK`}
        />
        <StatCard
          title="Avg Latency"
          value={latency.value}
          suffix={latency.suffix}
          accent="bg-warning"
        />
        <StatCard
          title="Active Providers"
          value={stats.activeProviders}
          accent="bg-info"
          subline={`of ${stats.totalProviders} configured`}
        />
      </div>
      <UsageChart data={usage} summary={week} />
    </div>
  );
}
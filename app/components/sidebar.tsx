import { Form, NavLink } from "react-router";
import {
	Home,
	Plug,
	FileArchive,
	KeySquare,
	Link2,
	FolderOpen,
	LogOut,
	ScrollText,
	TrendingUp,
	Network,
	Bot,
	Cable,
	X,
} from "lucide-react";
import { Button } from "./ui/button";

const NAV_ITEMS = [
	{ to: "/home", label: "Home", icon: Home },
	{ to: "/providers", label: "Provider", icon: Plug },
	{ to: "/compression", label: "Compression", icon: FileArchive },
	{ to: "/api-manager", label: "API Manager", icon: KeySquare },
	{ to: "/combo", label: "Combo", icon: Link2 },
	{ to: "/proxies", label: "Proxies", icon: Network },
];

// Grouped under "Tools" — utilities that configure external tooling.
const TOOLS_ITEMS = [
	{ to: "/mcp", label: "MCP Server", icon: Cable },
	{ to: "/agents", label: "AI Agents", icon: Bot },
];

// Grouped under "Monitoring" — request + proxy log viewers.
const MONITORING_ITEMS = [
	{ to: "/logs", label: "Request Logs", icon: ScrollText },
	{ to: "/logs/proxy", label: "Proxy Logs", icon: FolderOpen },
];

// Grouped under "Analytics" — usage and charts.
const ANALYTICS_ITEMS = [
	{ to: "/analytics/usage", label: "Usage", icon: TrendingUp },
];

function linkClass({ isActive }: { isActive: boolean }): string {
	return [
		"flex items-center gap-3 rounded-lg border-l-2 px-3 py-2 text-sm font-medium transition-colors",
		isActive
			? "border-l-primary bg-primary/15 text-primary"
			: "border-l-transparent text-muted-foreground hover:bg-glass-hover hover:text-foreground",
	].join(" ");
}

function SectionLabel({ children }: { children: string }) {
	return (
		<p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
			{children}
		</p>
	);
}

function Brand() {
	return (
		<div className="border-b border-glass-border px-4 py-4">
			<h1 className="text-lg font-bold text-foreground">UniRoute</h1>
			<p className="text-xs text-muted-foreground">AI Gateway Admin</p>
		</div>
	);
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
	return (
		<>
			<nav className="flex-1 space-y-1 overflow-y-auto p-3">
				{NAV_ITEMS.map((item) => {
					const Icon = item.icon;
					return (
						<NavLink
							key={item.to}
							to={item.to}
							prefetch="intent"
							className={linkClass}
							end={item.to === "/home"}
							onClick={onNavigate}
						>
							<Icon size={16} />
							{item.label}
						</NavLink>
					);
				})}

				<div className="pt-3">
					<SectionLabel>Tools</SectionLabel>
					{TOOLS_ITEMS.map((item) => {
						const Icon = item.icon;
						return (
							<NavLink
								key={item.to}
								to={item.to}
								prefetch="intent"
								className={linkClass}
								onClick={onNavigate}
							>
								<Icon size={16} />
								{item.label}
							</NavLink>
						);
					})}
				</div>

				<div className="pt-3">
					<SectionLabel>Monitoring</SectionLabel>
					{MONITORING_ITEMS.map((item) => {
						const Icon = item.icon;
						return (
							<NavLink
								key={item.to}
								to={item.to}
								prefetch="intent"
								className={linkClass}
								end={item.to === "/logs"}
								onClick={onNavigate}
							>
								<Icon size={16} />
								{item.label}
							</NavLink>
						);
					})}
				</div>

				<div className="pt-3">
					<SectionLabel>Analytics</SectionLabel>
					{ANALYTICS_ITEMS.map((item) => {
						const Icon = item.icon;
						return (
							<NavLink
								key={item.to}
								to={item.to}
								prefetch="intent"
								className={linkClass}
								end={item.to === "/analytics/usage"}
								onClick={onNavigate}
							>
								<Icon size={16} />
								{item.label}
							</NavLink>
						);
					})}
				</div>
			</nav>

			<div className="border-t border-glass-border p-3">
				<Form method="post" action="/logout">
					<Button
						type="submit"
						variant="ghost"
						className="w-full justify-center"
					>
						<LogOut size={16} />
						Logout
					</Button>
				</Form>
			</div>
		</>
	);
}

type SidebarProps = {
	open: boolean;
	onClose: () => void;
};

export function Sidebar({ open, onClose }: SidebarProps) {
	return (
		<>
			<aside className="hidden w-64 shrink-0 flex-col border-r border-glass-border bg-background/70 backdrop-blur-md md:flex">
				<Brand />
				<SidebarContent />
			</aside>

			<div
				inert={!open}
				className={`fixed inset-0 z-50 transition-opacity md:hidden ${
					open ? "opacity-100" : "pointer-events-none opacity-0"
				}`}
				aria-hidden={!open}
			>
				<div className="absolute inset-0 bg-background/50" onClick={onClose} />
				<aside
					className={`absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col border-r border-glass-border bg-background/80 shadow-xl backdrop-blur-md transition-transform duration-200 ease-out ${
						open ? "translate-x-0" : "-translate-x-full"
					}`}
				>
					<div className="flex items-center justify-between border-b border-glass-border px-4 py-4">
						<div>
							<h1 className="text-lg font-bold text-foreground">UniRoute</h1>
							<p className="text-xs text-muted-foreground">AI Gateway Admin</p>
						</div>
						<button
							type="button"
							onClick={onClose}
							aria-label="Close menu"
							className="rounded-lg p-1.5 text-muted-foreground hover:bg-glass-hover hover:text-foreground"
						>
							<X size={20} />
						</button>
					</div>
					<SidebarContent onNavigate={onClose} />
				</aside>
			</div>
		</>
	);
}

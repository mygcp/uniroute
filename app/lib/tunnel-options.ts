export type TunnelProviderId = "cloudflared" | "ngrok" | "frpc" | "bore";

export const VALID_TUNNEL_PROVIDERS = new Set<TunnelProviderId>([
  "cloudflared",
  "ngrok",
  "frpc",
  "bore",
]);

export type CloudflaredMode = "quick" | "token";
export type CloudflaredProtocol = "auto" | "http2" | "quic";
export type NgrokRegion = "auto" | "us" | "eu" | "ap" | "au" | "sa" | "jp" | "in";
export type FrpcProtocol = "http" | "https";

export type TunnelStateStatus =
  | "stopped"
  | "starting"
  | "running"
  | "reconnecting"
  | "error";

export type TunnelProviderMeta = {
  id: TunnelProviderId;
  name: string;
  shortName: string;
  tagline: string;
  repoUrl: string;
  docsUrl: string;
  license: string;
  supportsQuick: boolean;
  supportsDomain: boolean;
  supportsSelfHosted: boolean;
};

export const TUNNEL_PROVIDERS: TunnelProviderMeta[] = [
  {
    id: "cloudflared",
    name: "Cloudflare Tunnel (cloudflared)",
    shortName: "cloudflared",
    tagline:
      "Free quick trycloudflare.com URLs without an account, or named Zero Trust tunnels bound to your own custom domain.",
    repoUrl: "https://github.com/cloudflare/cloudflared",
    docsUrl: "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/",
    license: "Apache-2.0",
    supportsQuick: true,
    supportsDomain: true,
    supportsSelfHosted: false,
  },
  {
    id: "ngrok",
    name: "ngrok",
    shortName: "ngrok",
    tagline:
      "Instant HTTPS tunnel with traffic inspection, static ngrok domains, and custom branded domains on paid plans.",
    repoUrl: "https://ngrok.com",
    docsUrl: "https://ngrok.com/docs",
    license: "Proprietary",
    supportsQuick: true,
    supportsDomain: true,
    supportsSelfHosted: false,
  },
  {
    id: "frpc",
    name: "FRP Client (frpc)",
    shortName: "frpc",
    tagline:
      "Fast reverse proxy client connecting to your own VPS running frps for unlimited custom domains and subdomains.",
    repoUrl: "https://github.com/fatedier/frp",
    docsUrl: "https://gofrp.org/en/docs/",
    license: "Apache-2.0",
    supportsQuick: false,
    supportsDomain: true,
    supportsSelfHosted: true,
  },
  {
    id: "bore",
    name: "bore",
    shortName: "bore",
    tagline:
      "Minimalist Rust TCP tunnel for quick bore.pub forwarding or self-hosted bore-server setups.",
    repoUrl: "https://github.com/ekzhang/bore",
    docsUrl: "https://github.com/ekzhang/bore",
    license: "MIT",
    supportsQuick: true,
    supportsDomain: false,
    supportsSelfHosted: true,
  },
];

export const CLOUDFLARED_MODES: { value: CloudflaredMode; label: string }[] = [
  {
    value: "quick",
    label: "Quick Tunnel (*.trycloudflare.com, free)",
  },
  {
    value: "token",
    label: "Named Tunnel (Zero Trust token + domain)",
  },
];

export const CLOUDFLARED_PROTOCOLS: { value: CloudflaredProtocol; label: string }[] = [
  { value: "auto", label: "Auto (QUIC with HTTP/2 fallback)" },
  { value: "http2", label: "HTTP/2 (firewall / VPS friendly)" },
  { value: "quic", label: "QUIC (UDP, lowest latency)" },
];

export const NGROK_REGIONS: { value: NgrokRegion; label: string }[] = [
  { value: "auto", label: "Auto (nearest region)" },
  { value: "us", label: "United States (us)" },
  { value: "eu", label: "Europe (eu)" },
  { value: "ap", label: "Asia Pacific (ap)" },
  { value: "au", label: "Australia (au)" },
  { value: "sa", label: "South America (sa)" },
  { value: "jp", label: "Japan (jp)" },
  { value: "in", label: "India (in)" },
];

export const FRPC_PROTOCOLS: { value: FrpcProtocol; label: string }[] = [
  { value: "http", label: "HTTP (recommended behind frps TLS)" },
  { value: "https", label: "HTTPS (end-to-end TLS passthrough)" },
];

export type TunnelSettings = {
  provider: TunnelProviderId;
  auto_start: boolean;
  auto_reconnect: boolean;
  local_host: string;
  local_port: number;
  custom_domain: string;
  prefer_https: boolean;
  cloudflared_mode: CloudflaredMode;
  cloudflared_token: string;
  cloudflared_protocol: CloudflaredProtocol;
  cloudflared_binary_path: string;
  ngrok_authtoken: string;
  ngrok_region: NgrokRegion;
  ngrok_binary_path: string;
  frpc_server_addr: string;
  frpc_server_port: number;
  frpc_token: string;
  frpc_subdomain: string;
  frpc_protocol: FrpcProtocol;
  frpc_binary_path: string;
  bore_server: string;
  bore_remote_port: number;
  bore_secret: string;
  bore_binary_path: string;
};

export type PublicTunnelSettings = Omit<
  TunnelSettings,
  "cloudflared_token" | "ngrok_authtoken" | "frpc_token" | "bore_secret"
> & {
  has_cloudflared_token: boolean;
  has_ngrok_authtoken: boolean;
  has_frpc_token: boolean;
  has_bore_secret: boolean;
};

export type TunnelLogEntry = {
  ts: string;
  stream: "stdout" | "stderr" | "system";
  line: string;
};

export type TunnelRuntimeStatus = {
  status: TunnelStateStatus;
  provider: TunnelProviderId;
  publicUrl: string | null;
  localTarget: string | null;
  pid: number | null;
  startedAt: number | null;
  reconnectAttempts: number;
  lastError: string | null;
  logs: TunnelLogEntry[];
};

export type TunnelInstallCommand = {
  label: string;
  command: string;
};

export type TunnelToolSource = "managed" | "path" | "custom" | "missing";

export type TunnelToolStatus = {
  id: TunnelProviderId;
  name: string;
  shortName: string;
  tagline: string;
  repoUrl: string;
  docsUrl: string;
  license: string;
  supportsQuick: boolean;
  supportsDomain: boolean;
  supportsSelfHosted: boolean;
  installed: boolean;
  isManaged: boolean;
  source: TunnelToolSource;
  resolvedPath: string | null;
  configuredPath: string;
  managedPath: string;
  version: string | null;
  sizeBytes: number | null;
  installCommands: TunnelInstallCommand[];
};

export type DownloadTunnelToolResult = {
  tool: TunnelProviderId;
  tag: string;
  assetName: string;
  binaryPath: string;
  version: string | null;
  sha256: string;
  checksumVerified: boolean;
  sizeBytes: number;
  upToDate?: boolean;
};

export const DEFAULT_TUNNEL_SETTINGS: TunnelSettings = {
  provider: "cloudflared",
  auto_start: false,
  auto_reconnect: true,
  local_host: "127.0.0.1",
  local_port: 0,
  custom_domain: "",
  prefer_https: true,
  cloudflared_mode: "quick",
  cloudflared_token: "",
  cloudflared_protocol: "auto",
  cloudflared_binary_path: "",
  ngrok_authtoken: "",
  ngrok_region: "auto",
  ngrok_binary_path: "",
  frpc_server_addr: "",
  frpc_server_port: 7000,
  frpc_token: "",
  frpc_subdomain: "",
  frpc_protocol: "http",
  frpc_binary_path: "",
  bore_server: "bore.pub",
  bore_remote_port: 0,
  bore_secret: "",
  bore_binary_path: "",
};

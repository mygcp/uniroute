import { Loader2 } from "lucide-react";

export function Spinner({ size = 16, className = "" }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={`animate-spin ${className}`} />;
}

export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div className={`animate-shimmer rounded-md bg-muted ${className}`} aria-hidden="true" />
  );
}
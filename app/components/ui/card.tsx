import type { HTMLAttributes } from "react";

export function Card({
  padded = true,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & { padded?: boolean }) {
  return (
    <div
      className={[
        "rounded-xl border border-border bg-surface shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30",
        padded ? "p-5" : "",
        className,
      ].join(" ")}
      {...rest}
    />
  );
}

export function CardHeader({ className = "", ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={["mb-4 flex items-center justify-between gap-3", className].join(" ")} {...rest} />;
}

export function CardTitle({ className = "", ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={["text-sm font-semibold text-foreground", className].join(" ")} {...rest} />;
}
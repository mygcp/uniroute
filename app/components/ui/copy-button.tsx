import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "./button";
import { copyText } from "../../lib/clipboard";

export function CopyButton({
  text,
  label = "Copy",
  className = "",
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="icon"
      type="button"
      title={copied ? "Copied" : label}
      aria-label={label}
      className={[
        "hover:border-border",
        copied ? "border-success/40 text-success hover:text-success" : "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? (
        <Check size={14} className="text-success" aria-hidden="true" />
      ) : (
        <Copy size={14} aria-hidden="true" />
      )}
    </Button>
  );
}

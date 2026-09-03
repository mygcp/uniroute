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
      title={label}
      aria-label={label}
      className={className}
      onClick={async () => {
        const ok = await copyText(text);
        if (ok) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
    >
      {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
    </Button>
  );
}

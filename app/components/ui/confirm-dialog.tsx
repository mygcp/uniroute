import { useRef, useState, useEffect, useCallback, useId } from "react";
import { AlertTriangle, HelpCircle, X } from "lucide-react";
import { Button } from "./button";

type ConfirmOptions = {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "primary" | "danger";
};

type Pending = { opts: ConfirmOptions; resolve: (v: boolean) => void };

export function useConfirm() {
  const [pending, setPending] = useState<Pending | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pendingRef = useRef<Pending | null>(null);
  const titleId = useId();
  const descId = useId();
  pendingRef.current = pending;

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      if (pendingRef.current) {
        pendingRef.current.resolve(false);
      }
      setPending({ opts, resolve });
    });
  }, []);

  useEffect(() => {
    if (pending && !dialogRef.current?.open) dialogRef.current?.showModal();
  }, [pending]);

  const close = (result: boolean) => {
    dialogRef.current?.close();
    pending?.resolve(result);
    setPending(null);
  };

  const isDanger = pending?.opts.variant === "danger";

  const dialog = pending ? (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={pending.opts.description ? descId : undefined}
      className="dialog-pop m-auto w-[min(92vw,440px)] overflow-hidden rounded-lg border border-border-strong bg-surface p-0 text-foreground shadow-2xl backdrop:bg-black/65"
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) close(false);
      }}
    >
      <div className="flex items-start gap-3 p-5">
        <span
          className={`mt-0.5 shrink-0 ${isDanger ? "text-danger" : "text-primary"}`}
        >
          {isDanger ? (
            <AlertTriangle size={18} aria-hidden="true" />
          ) : (
            <HelpCircle size={18} aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-base font-semibold leading-snug text-foreground">
            {pending.opts.title}
          </h3>
          {pending.opts.description ? (
            <p id={descId} className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {pending.opts.description}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={() => close(false)}
          aria-label="Close dialog"
          className="-mt-1 -mr-1 h-7 w-7 shrink-0"
        >
          <X size={15} aria-hidden="true" />
        </Button>
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border bg-surface-2/40 px-5 py-3">
        <Button variant="outline" size="sm" onClick={() => close(false)}>
          {pending.opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          variant={isDanger ? "danger-solid" : "primary"}
          size="sm"
          onClick={() => close(true)}
        >
          {pending.opts.confirmLabel ?? "Confirm"}
        </Button>
      </div>
    </dialog>
  ) : null;

  return { dialog, confirm };
}

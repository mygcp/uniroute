import { useRef, useState, useEffect, useCallback } from "react";
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

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
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

  const dialog = pending ? (
    <dialog
      ref={dialogRef}
      className="dialog-pop m-auto w-[min(92vw,420px)] rounded-xl border border-border bg-surface p-5 text-foreground shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm"
      onCancel={(e) => {
        e.preventDefault();
        close(false);
      }}
      onClick={(e) => {
        if (e.target === dialogRef.current) close(false);
      }}
    >
      <h3 className="text-base font-semibold">{pending.opts.title}</h3>
      {pending.opts.description ? (
        <p className="mt-1.5 text-sm text-muted-foreground">{pending.opts.description}</p>
      ) : null}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => close(false)}>
          {pending.opts.cancelLabel ?? "Cancel"}
        </Button>
        <Button
          variant={pending.opts.variant === "danger" ? "danger" : "primary"}
          onClick={() => close(true)}
        >
          {pending.opts.confirmLabel ?? "Confirm"}
        </Button>
      </div>
    </dialog>
  ) : null;

  return { dialog, confirm };
}
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { CheckCircle2, Info, XCircle } from "lucide-react";

type ToastInput = {
  title: string;
  description?: string;
  variant?: "success" | "error" | "info";
};

type ToastItem = ToastInput & { id: number; leaving?: boolean };

const ToastContext = createContext<{ toast: (t: ToastInput) => void }>({
  toast: () => {},
});

const ICONS = {
  success: <CheckCircle2 size={16} className="text-success" />,
  error: <XCircle size={16} className="text-danger" />,
  info: <Info size={16} className="text-info" />,
};

const LIFETIME_MS = 4000;
const EXIT_MS = 250;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback((t: ToastInput) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { ...t, id }]);
    // Play the exit animation first, then unmount.
    setTimeout(() => {
      setItems((prev) =>
        prev.map((i) => (i.id === id ? { ...i, leaving: true } : i)),
      );
    }, LIFETIME_MS);
    setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.id !== id));
    }, LIFETIME_MS + EXIT_MS);
  }, []);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-2">
        {items.map((t) => (
          <div
            key={t.id}
            role="status"
            className={`pointer-events-auto flex items-start gap-2.5 rounded-lg border border-glass-border bg-background/80 p-3 text-sm text-foreground shadow-[0_8px_24px_rgba(0,0,0,0.35),inset_0_1px_0_var(--glass-highlight)] backdrop-blur-md ${
              t.leaving ? "animate-toast-out" : "animate-toast-in"
            }`}
          >
            <span className="mt-0.5 shrink-0">{ICONS[t.variant ?? "info"]}</span>
            <div className="min-w-0">
              <p className="font-medium">{t.title}</p>
              {t.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{t.description}</p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

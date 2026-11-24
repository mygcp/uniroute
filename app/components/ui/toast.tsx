import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";

type ToastVariant = "success" | "error" | "warning" | "info";

type ToastInput = {
  title: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
};

type ToastItem = ToastInput & { id: number; leaving?: boolean };

const ToastContext = createContext<{ toast: (t: ToastInput) => void }>({
  toast: () => {},
});

const VARIANT_STYLES: Record<
  ToastVariant,
  {
    icon: React.ReactNode;
    iconBox: string;
    borderAccent: string;
    progressBar: string;
  }
> = {
  success: {
    icon: <CheckCircle2 size={15} aria-hidden="true" />,
    iconBox: "border-success/30 bg-success/12 text-success",
    borderAccent: "border-l-success",
    progressBar: "bg-success",
  },
  error: {
    icon: <XCircle size={15} aria-hidden="true" />,
    iconBox: "border-danger/30 bg-danger/12 text-danger",
    borderAccent: "border-l-danger",
    progressBar: "bg-danger",
  },
  warning: {
    icon: <AlertTriangle size={15} aria-hidden="true" />,
    iconBox: "border-warning/30 bg-warning/12 text-warning",
    borderAccent: "border-l-warning",
    progressBar: "bg-warning",
  },
  info: {
    icon: <Info size={15} aria-hidden="true" />,
    iconBox: "border-info/30 bg-info/12 text-info",
    borderAccent: "border-l-info",
    progressBar: "bg-info",
  },
};

const DEFAULT_LIFETIME_MS = 4500;
const ERROR_LIFETIME_MS = 6500;
const EXIT_MS = 250;
const MAX_ITEMS = 6;

function lifetimeOf(t: ToastInput): number {
  if (t.durationMs != null && Number.isFinite(t.durationMs)) {
    return Math.max(1500, t.durationMs);
  }
  return t.variant === "error" ? ERROR_LIFETIME_MS : DEFAULT_LIFETIME_MS;
}

function ToastCard({
  item,
  lifetime,
  onDone,
}: {
  item: ToastItem;
  lifetime: number;
  onDone: (id: number) => void;
}) {
  const [paused, setPaused] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const remainingRef = useRef(lifetime);
  const startedRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current != null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const schedule = useCallback(
    (ms: number) => {
      clearTimer();
      startedRef.current = Date.now();
      timerRef.current = setTimeout(() => {
        setLeaving(true);
        timerRef.current = setTimeout(() => onDone(item.id), EXIT_MS);
      }, ms);
    },
    [item.id, onDone],
  );

  useEffect(() => {
    schedule(remainingRef.current);
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const closeManual = () => {
    clearTimer();
    setLeaving(true);
    window.setTimeout(() => onDone(item.id), EXIT_MS);
  };

  const onEnter = () => {
    if (leaving) return;
    clearTimer();
    remainingRef.current = Math.max(
      0,
      remainingRef.current - (Date.now() - startedRef.current),
    );
    setPaused(true);
  };

  const onLeave = () => {
    if (leaving) return;
    setPaused(false);
    schedule(remainingRef.current);
  };

  const variant = item.variant ?? "info";
  const style = VARIANT_STYLES[variant];

  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={`pointer-events-auto relative flex items-start gap-3 overflow-hidden rounded-xl border border-border-strong border-l-[3px] ${style.borderAccent} bg-surface p-3.5 pb-4 text-sm text-foreground shadow-xl ${
        leaving || item.leaving ? "animate-toast-out" : "animate-toast-in"
      }`}
    >
      <span
        className={`mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${style.iconBox}`}
      >
        {style.icon}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="pr-1 text-sm font-semibold leading-snug text-foreground">
          {item.title}
        </p>
        {item.description ? (
          <p className="mt-1 break-words text-xs leading-relaxed text-muted-foreground">
            {item.description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onClick={closeManual}
        aria-label="Dismiss notification"
        title="Dismiss"
        className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <X size={14} aria-hidden="true" />
      </button>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-surface-2"
      >
        <span
          className={`animate-toast-progress block h-full ${style.progressBar} opacity-80`}
          style={{
            animationDuration: `${lifetime}ms`,
            animationPlayState: paused || leaving ? "paused" : "running",
          }}
        />
      </span>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const remove = useCallback((id: number) => {
    setItems((prev) => prev.filter((i) => i.id !== id));
  }, []);

  const toast = useCallback((t: ToastInput) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev.slice(-(MAX_ITEMS - 1)), { ...t, id }]);
  }, []);

  const lifetimes = useMemo(() => {
    const map = new Map<number, number>();
    for (const i of items) map.set(i.id, lifetimeOf(i));
    return map;
  }, [items]);

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed right-3 bottom-3 left-3 z-[100] flex max-h-[46vh] flex-col gap-2 overflow-x-hidden overflow-y-auto sm:right-4 sm:bottom-4 sm:left-auto sm:w-[380px]"
      >
        {items.map((t) => (
          <ToastCard
            key={t.id}
            item={t}
            lifetime={lifetimes.get(t.id) ?? DEFAULT_LIFETIME_MS}
            onDone={remove}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

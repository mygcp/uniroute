import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";

type ToastInput = {
  title: string;
  description?: string;
  variant?: "success" | "error" | "info";
  /** Auto-close dalam ms (default 4500, error 6500). */
  durationMs?: number;
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

const DEFAULT_LIFETIME_MS = 4500;
const ERROR_LIFETIME_MS = 6500;
const EXIT_MS = 250;
/** Maksimal item yang disimpan — wadah bisa di-scroll bila lebih dari ~3. */
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

  return (
    <div
      role="status"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      className={`pointer-events-auto relative flex items-start gap-2.5 overflow-hidden rounded-lg border border-glass-border bg-background/80 p-3 pr-2 text-sm text-foreground shadow-[0_8px_24px_rgba(0,0,0,0.35),inset_0_1px_0_var(--glass-highlight)] backdrop-blur-md ${
        leaving || item.leaving ? "animate-toast-out" : "animate-toast-in"
      }`}
    >
      <span className="mt-0.5 shrink-0">{ICONS[item.variant ?? "info"]}</span>
      <div className="min-w-0 flex-1">
        <p className="pr-1 text-sm font-medium">{item.title}</p>
        {item.description ? (
          <p className="mt-0.5 text-xs break-words text-muted-foreground">
            {item.description}
          </p>
        ) : null}
      </div>
      {/* Tombol X manual + ring countdown yang melingkari */}
      <button
        type="button"
        onClick={closeManual}
        aria-label="Dismiss notification"
        title="Dismiss"
        className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-glass-hover hover:text-foreground"
      >
        <svg
          viewBox="0 0 28 28"
          className="absolute inset-0 h-full w-full -rotate-90"
          aria-hidden="true"
        >
          <circle
            cx="14"
            cy="14"
            r="11"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.2"
            strokeWidth="2"
          />
          <circle
            cx="14"
            cy="14"
            r="11"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            pathLength={100}
            className="animate-toast-ring"
            style={{
              animationDuration: `${lifetime}ms`,
              animationPlayState: paused || leaving ? "paused" : "running",
            }}
          />
        </svg>
        <X size={14} />
      </button>
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
      {/* Android-toast-like: full-width bottom bar di mobile, pojok kanan di desktop.
          Maks ~3 terlihat, selebihnya scroll selama timer/manual belum selesai. */}
      <div className="pointer-events-none fixed right-3 bottom-3 left-3 z-[100] flex max-h-[46vh] flex-col gap-2 overflow-y-auto sm:right-4 sm:bottom-4 sm:left-auto sm:w-[380px]">
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

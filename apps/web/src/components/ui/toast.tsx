"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
import { cx } from "./primitives";

type Toast = { id: number; tone: "ok" | "error" | "info"; message: string; detail?: string };
type Ctx = { notify: (tone: Toast["tone"], message: string, detail?: string) => void };

const ToastContext = createContext<Ctx>({ notify: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

/** Toasts are mirrored into polite/assertive live regions so screen readers hear them. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const seq = useRef(0);
  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const notify = useCallback<Ctx["notify"]>((tone, message, detail) => {
    const id = ++seq.current;
    setItems((xs) => [...xs.slice(-3), { id, tone, message, detail }]);
    setTimeout(() => dismiss(id), tone === "error" ? 9000 : 5000);
  }, [dismiss]);
  const value = useMemo(() => ({ notify }), [notify]);
  const polite = items.filter((t) => t.tone !== "error");
  const assertive = items.filter((t) => t.tone === "error");
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sr-only" aria-live="polite" aria-atomic="false">{polite.map((t) => <p key={t.id}>{t.message} {t.detail}</p>)}</div>
      <div className="sr-only" aria-live="assertive" aria-atomic="false">{assertive.map((t) => <p key={t.id}>{t.message} {t.detail}</p>)}</div>
      <div className="fixed z-[60] bottom-20 lg:bottom-6 right-4 left-4 sm:left-auto sm:w-96 flex flex-col gap-2 pointer-events-none" aria-hidden>
        {items.map((t) => {
          const Icon = t.tone === "ok" ? CheckCircle2 : t.tone === "error" ? AlertTriangle : Info;
          return (
            <div key={t.id} className="pointer-events-auto rounded-lg border border-line bg-surface shadow-lg px-4 py-3 flex items-start gap-2.5 text-sm">
              <Icon className={cx("size-4 mt-0.5 shrink-0", t.tone === "ok" ? "text-ok" : t.tone === "error" ? "text-danger" : "text-info")} />
              <div className="min-w-0 flex-1">
                <p className="text-ink">{t.message}</p>
                {t.detail ? <p className="text-[12px] text-muted mt-0.5 break-words">{t.detail}</p> : null}
              </div>
              <button type="button" tabIndex={-1} onClick={() => dismiss(t.id)} className="text-muted hover:text-ink">
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

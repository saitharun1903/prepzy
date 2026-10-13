"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiFetch, type Query } from "./api";
import type { Operation } from "./types";

/** Load JSON from the API through the proxy. `path === null` disables loading. */
export function useApi<T>(path: string | null, query?: Query) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [tick, setTick] = useState(0);
  const qKey = JSON.stringify(query ?? {});

  useEffect(() => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    apiFetch<T>(path, { query: JSON.parse(qKey) as Query, signal: ctrl.signal })
      .then((d) => {
        if (!ctrl.signal.aborted) setData(d);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
        setError(e instanceof ApiError ? e : new ApiError({ status: 0, code: "unknown", message: String((e as Error)?.message || e) }));
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [path, qKey, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

const BACKOFF = [1000, 2000, 4000, 5000];

/** Follow a durable operation. Polls with backoff (1s, 2s, 4s, then every 5s), stops when terminal or unmounted. */
export function useOperation<R = Record<string, unknown>>(
  opId: string | null,
  onTerminal?: (op: Operation<R>) => void,
) {
  const [op, setOp] = useState<Operation<R> | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);
  const cb = useRef(onTerminal);
  cb.current = onTerminal;

  useEffect(() => {
    if (!opId) {
      setOp(null);
      return;
    }
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let i = 0;
    setError(null);
    const poll = async () => {
      try {
        const o = await apiFetch<Operation<R>>(`operations/${opId}`, { signal: ctrl.signal });
        if (ctrl.signal.aborted) return;
        setOp(o);
        if (o.terminal) {
          cb.current?.(o);
          return;
        }
      } catch (e) {
        if (ctrl.signal.aborted || (e as Error)?.name === "AbortError") return;
        const err = e instanceof ApiError ? e : new ApiError({ status: 0, code: "unknown", message: String(e) });
        setError(err);
        if (!err.retryable && err.status !== 0) return;
      }
      timer = setTimeout(poll, BACKOFF[Math.min(i++, BACKOFF.length - 1)]);
    };
    void poll();
    return () => {
      ctrl.abort();
      if (timer) clearTimeout(timer);
    };
  }, [opId, nonce]);

  const cancel = useCallback(async () => {
    if (!opId) return;
    const o = await apiFetch<Operation<R>>(`operations/${opId}/cancel`, { method: "POST" });
    setOp(o);
    if (!o.terminal) setNonce((n) => n + 1);
    else cb.current?.(o);
  }, [opId]);

  const retry = useCallback(async () => {
    if (!opId) return;
    const o = await apiFetch<Operation<R>>(`operations/${opId}/retry`, { method: "POST" });
    setOp(o);
    setNonce((n) => n + 1);
  }, [opId]);

  return { op, error, cancel, retry };
}

/** sessionStorage-backed draft (survives reloads in this tab, cleared when the tab closes). */
export function useSessionDraft(key: string, initial = "") {
  const [value, setValue] = useState(initial);
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const v = sessionStorage.getItem(key);
      if (v !== null) setValue(v);
    } catch {
      /* storage unavailable */
    }
    loaded.current = true;
  }, [key]);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      if (value) sessionStorage.setItem(key, value);
      else sessionStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  const clear = useCallback(() => {
    setValue("");
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  }, [key]);
  return [value, setValue, clear] as const;
}

/** Warn before closing/reloading the tab while there is unsaved text. */
export function useBeforeUnload(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    // In-app link navigation does not fire beforeunload; confirm it too.
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || url.pathname === location.pathname) return;
      if (!window.confirm("You have unsaved text on this page. Leave anyway? (A draft is kept in this tab.)")) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", h);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", h);
      document.removeEventListener("click", onClick, true);
    };
  }, [active]);
}

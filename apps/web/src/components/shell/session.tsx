"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter, usePathname } from "next/navigation";
import { apiFetch, setUnauthenticatedHandler, type ApiError } from "@/lib/api";
import type { Me } from "@/lib/types";

type SessionCtx = {
  me: Me | null;
  meError: ApiError | null;
  unread: number;
  refreshUnread: () => void;
  reloadMe: () => void;
};

const Ctx = createContext<SessionCtx>({ me: null, meError: null, unread: 0, refreshUnread: () => {}, reloadMe: () => {} });

export function useSession() {
  return useContext(Ctx);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<ApiError | null>(null);
  const [unread, setUnread] = useState(0);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      const next = typeof window !== "undefined" ? window.location.pathname + window.location.search : "/";
      router.replace(`/login?next=${encodeURIComponent(next)}`);
    });
    return () => setUnauthenticatedHandler(null);
  }, [router]);

  useEffect(() => {
    apiFetch<Me>("me").then((m) => { setMe(m); setMeError(null); }).catch((e: ApiError) => setMeError(e));
  }, [tick]);

  const refreshUnread = useCallback(() => {
    apiFetch<{ unread: number }>("notifications", { query: { limit: 1 } })
      .then((r) => setUnread(r.unread))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshUnread();
  }, [pathname, refreshUnread]);

  useEffect(() => {
    const id = setInterval(refreshUnread, 60_000);
    return () => clearInterval(id);
  }, [refreshUnread]);

  return (
    <Ctx.Provider value={{ me, meError, unread, refreshUnread, reloadMe: () => setTick((t) => t + 1) }}>
      {children}
    </Ctx.Provider>
  );
}

import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

/** Server-only session helpers. Tokens live exclusively in HttpOnly cookies; browser JS never sees them. */

export const ACCESS_COOKIE = "el_at";
export const REFRESH_COOKIE = "el_rt";
/** Non-secret marker (no token inside) so page navigation can tell a session exists after el_at expires.
 * el_rt is scoped to Path=/api and is therefore not sent with page requests. */
export const SESSION_MARKER = "el_s";
const REFRESH_MAX_AGE = 60 * 60 * 24 * 30;

export function apiBase(): string {
  // ELEVATE_API_HOSTPORT: private-network "host:port" injected by the hosting platform (preferred:
  // web -> API traffic never leaves the private network). Otherwise a full URL in ELEVATE_API_URL.
  const hp = process.env.ELEVATE_API_HOSTPORT;
  if (hp && /^[a-z0-9.-]+:\d{2,5}$/i.test(hp)) return `http://${hp}`;
  return (process.env.ELEVATE_API_URL || "http://127.0.0.1:8000").replace(/\/+$/, "");
}

const secure = () => process.env.NODE_ENV === "production";

export type ApiUser = { id: string; email: string; display_name: string | null; is_admin: boolean; timezone: string };
export type TokenOut = { access_token: string; expires_in: number; refresh_token: string; user: ApiUser };

export function setSessionCookies(res: NextResponse, t: { access_token: string; expires_in: number; refresh_token: string }) {
  res.cookies.set(ACCESS_COOKIE, t.access_token, {
    httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: Math.max(1, Math.floor(t.expires_in)),
  });
  res.cookies.set(REFRESH_COOKIE, t.refresh_token, {
    httpOnly: true, sameSite: "strict", secure: secure(), path: "/api", maxAge: REFRESH_MAX_AGE,
  });
  res.cookies.set(SESSION_MARKER, "1", {
    httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: REFRESH_MAX_AGE,
  });
}

export function clearSessionCookies(res: NextResponse) {
  res.cookies.set(ACCESS_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 0 });
  res.cookies.set(REFRESH_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: secure(), path: "/api", maxAge: 0 });
  res.cookies.set(SESSION_MARKER, "", { httpOnly: true, sameSite: "lax", secure: secure(), path: "/", maxAge: 0 });
}

export function errorJson(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
  return NextResponse.json(
    { error: { code, message, request_id: null, retryable: false, fields: {}, ...extra } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

/** Origins this app is served from. The request's own Host is accepted plus any ELEVATE_APP_ORIGINS. */
function allowedOrigins(req: NextRequest): Set<string> {
  const out = new Set<string>();
  const host = req.headers.get("host");
  if (host) out.add(`${req.nextUrl.protocol}//${host}`);
  out.add(req.nextUrl.origin);
  for (const o of (process.env.ELEVATE_APP_ORIGINS || "").split(",")) {
    if (o.trim()) out.add(o.trim().replace(/\/+$/, ""));
  }
  return out;
}

/** CSRF defence for state-changing requests: same-origin Origin header AND the custom header. */
export function checkCsrf(req: NextRequest): NextResponse | null {
  const m = req.method.toUpperCase();
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return null;
  const origin = req.headers.get("origin");
  if (!origin || !allowedOrigins(req).has(origin)) {
    return errorJson(403, "csrf_rejected", "This request was blocked because it did not come from this site.");
  }
  if (req.headers.get("x-elevate-csrf") !== "1") {
    return errorJson(403, "csrf_rejected", "This request was blocked because it is missing the CSRF header.");
  }
  return null;
}

// ---------------------------------------------------------------- refresh with in-process de-duplication
// The API rotates refresh tokens and treats reuse of a consumed token as theft (revokes the family).
// Concurrent requests holding the same old refresh token must therefore share ONE refresh call, and
// requests that arrive shortly after with the old cookie must reuse its result rather than re-sending it.
type RefreshResult = { ok: true; tokens: TokenOut } | { ok: false; status: number };
const inflight = new Map<string, Promise<RefreshResult>>();
const RESULT_GRACE_MS = 30_000;

const keyOf = (rt: string) => createHash("sha256").update(rt).digest("hex");

export function refreshSession(refreshToken: string): Promise<RefreshResult> {
  const key = keyOf(refreshToken);
  const existing = inflight.get(key);
  if (existing) return existing;
  const p = (async (): Promise<RefreshResult> => {
    try {
      const r = await fetch(`${apiBase()}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
        cache: "no-store",
      });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, tokens: (await r.json()) as TokenOut };
    } catch {
      return { ok: false, status: 503 };
    }
  })();
  inflight.set(key, p);
  p.then((res) => {
    // Keep successful results briefly so racing requests with the old cookie get the same new tokens.
    setTimeout(() => inflight.delete(key), res.ok ? RESULT_GRACE_MS : 0);
  });
  return p;
}

/** Call the API's auth endpoints (no bearer). Returns status + parsed JSON (or null). */
export async function callAuth(path: string, body: unknown, bearer?: string): Promise<{ status: number; json: unknown }> {
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const r = await fetch(`${apiBase()}/api/v1/auth/${path}`, {
      method: "POST", headers, body: JSON.stringify(body ?? {}), cache: "no-store",
    });
    const text = await r.text();
    let json: unknown = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: r.status, json };
  } catch {
    return {
      status: 503,
      json: { error: { code: "api_unreachable", message: "The Elevate API is not reachable. Is it running?", request_id: null, retryable: true, fields: {} } },
    };
  }
}

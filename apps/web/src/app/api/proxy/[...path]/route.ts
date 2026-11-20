import { NextResponse, type NextRequest } from "next/server";
import {
  ACCESS_COOKIE, REFRESH_COOKIE, apiBase, checkCsrf, clearSessionCookies, errorJson, refreshSession, setSessionCookies,
  type TokenOut,
} from "@/lib/server/session";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

/** Top-level API segments the browser may reach. Everything else is rejected before leaving this server. */
const ALLOWED_TOP = new Set([
  "me", "jobs", "operations", "profile", "resumes", "match-reports", "interviews", "roadmaps", "applications",
  "notes", "reminders", "notifications", "knowledge", "account", "taxonomy", "admin",
]);
const ALLOWED_AUTH = new Set(["extension-grant", "change-password", "logout-all", "resend-verification"]);
/** Two-step verification endpoints: path under auth/ -> the only method allowed. */
const ALLOWED_MFA: Record<string, string> = {
  "mfa": "GET", "mfa/setup": "POST", "mfa/enable": "POST", "mfa/disable": "POST",
};
const SEGMENT = /^[A-Za-z0-9._~-]+$/;

const FORWARD_REQUEST_HEADERS = ["content-type", "idempotency-key", "accept"];
const FORWARD_RESPONSE_HEADERS = ["content-type", "content-disposition", "x-request-id", "retry-after"];

function allowed(path: string[], method: string): boolean {
  if (!path.length || path.some((s) => !SEGMENT.test(s) || s === "." || s === "..")) return false;
  if (path[0] === "auth") {
    const rest = path.slice(1).join("/");
    if (Object.hasOwn(ALLOWED_MFA, rest)) return ALLOWED_MFA[rest] === method.toUpperCase();
    return path.length === 2 && ALLOWED_AUTH.has(path[1]);
  }
  return ALLOWED_TOP.has(path[0]);
}

async function forward(req: NextRequest, url: string, body: ArrayBuffer | null, token: string | undefined) {
  const headers = new Headers();
  for (const h of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { method: req.method, headers, body, cache: "no-store", redirect: "manual" });
}

async function readCode(r: Response): Promise<string | null> {
  if (!(r.headers.get("content-type") || "").includes("application/json")) return null;
  try {
    const j = (await r.clone().json()) as { error?: { code?: string } };
    return j?.error?.code ?? null;
  } catch {
    return null;
  }
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const blocked = checkCsrf(req);
  if (blocked) return blocked;
  const { path } = await ctx.params;
  if (!allowed(path, req.method)) return errorJson(404, "not_found", "Unknown API path.");

  const url = `${apiBase()}/api/v1/${path.map(encodeURIComponent).join("/")}${req.nextUrl.search}`;
  const hasBody = !["GET", "HEAD"].includes(req.method.toUpperCase());
  const body = hasBody ? await req.arrayBuffer() : null;

  let access = req.cookies.get(ACCESS_COOKIE)?.value;
  const refresh = req.cookies.get(REFRESH_COOKIE)?.value;
  const state: { tokens: TokenOut | null } = { tokens: null };

  const doRefresh = async (): Promise<boolean> => {
    if (!refresh) return false;
    const res = await refreshSession(refresh);
    if (!res.ok) return false;
    state.tokens = res.tokens;
    access = res.tokens.access_token;
    return true;
  };

  if (!access) {
    if (!(await doRefresh())) {
      const res = errorJson(401, "unauthenticated", "Your session has ended. Sign in again.");
      clearSessionCookies(res);
      return res;
    }
  }

  let upstream: Response;
  try {
    upstream = await forward(req, url, body, access);
    if (upstream.status === 401 && !state.tokens) {
      const code = await readCode(upstream);
      if (code === "token_expired") {
        if (await doRefresh()) {
          upstream = await forward(req, url, body, access);
        } else {
          const res = errorJson(401, "unauthenticated", "Your session has ended. Sign in again.");
          clearSessionCookies(res);
          return res;
        }
      }
    }
  } catch {
    return errorJson(503, "api_unreachable", "The Prepzy API is not reachable. Is it running?", { retryable: true });
  }

  const headers = new Headers({ "Cache-Control": "no-store" });
  for (const h of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  const noBody = upstream.status === 204 || upstream.status === 304 || req.method === "HEAD";
  const buf = noBody ? null : await upstream.arrayBuffer();
  const res = new NextResponse(buf, { status: upstream.status, headers });

  // Any 401 that survived the refresh-and-retry above means the session is unusable (expired,
  // revoked, deleted account, invalid token): clear cookies so the next navigation goes to /login.
  if (upstream.status === 401) {
    clearSessionCookies(res);
    return res;
  }
  if (state.tokens) setSessionCookies(res, state.tokens);
  return res;
}

export { handle as GET, handle as POST, handle as PUT, handle as PATCH, handle as DELETE };

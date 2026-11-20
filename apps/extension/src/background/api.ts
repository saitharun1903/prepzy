// The ONLY module that talks to the Prepzy API. Runs in the service worker.

import type { components } from "@elevate/api-client";
import { API_BASE } from "../config";
import { AppError, authRequired, networkError } from "./errors";
import { clearAccountData, getLocal, getSession, setLocal, setSession, type StoredAccess, type StoredAuth } from "./storage";

const TIMEOUT_MS = 20_000;
const SKEW_MS = 30_000;
const SIGNED_OUT_CODES = new Set(["refresh_reused", "invalid_refresh", "refresh_expired"]);

type Method = "GET" | "POST" | "PATCH" | "DELETE";

type TokenOut = components["schemas"]["TokenOut"];

function buildUrl(path: string): string {
  // Paths are composed internally from validated ids; never from page or UI-provided URLs.
  if (!path.startsWith("/api/v1/") || path.includes("..") || /[\s#]/.test(path)) {
    throw new AppError("internal_error", "Invalid API path.");
  }
  return API_BASE.replace(/\/+$/, "") + path;
}

async function parseError(res: Response): Promise<AppError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const e = body && typeof body === "object" ? ((body as Record<string, unknown>).error as Record<string, unknown> | undefined) : undefined;
  const requestId = (typeof e?.request_id === "string" ? e.request_id : res.headers.get("X-Request-ID"))?.slice(0, 80) ?? null;
  const fields: Record<string, string> = {};
  if (e?.fields && typeof e.fields === "object") {
    for (const [k, v] of Object.entries(e.fields as Record<string, unknown>).slice(0, 10)) {
      if (typeof v === "string") fields[k.slice(0, 80)] = v.slice(0, 200);
    }
  }
  const extra: Record<string, unknown> = {};
  for (const k of ["application_id", "current_version", "retry_after"]) if (e && k in e) extra[k] = e[k];
  return new AppError(
    typeof e?.code === "string" ? e.code.slice(0, 80) : `http_${res.status}`,
    typeof e?.message === "string" ? e.message.slice(0, 1000) : `The server responded with status ${res.status}.`,
    { status: res.status, requestId, retryable: e?.retryable === true || res.status >= 500, fields, extra },
  );
}

async function rawFetch(method: Method, path: string, opts: { body?: unknown; token?: string; idempotencyKey?: string }): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  try {
    return await fetch(buildUrl(path), {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw networkError();
  }
}

function isTokenOut(x: unknown): x is TokenOut {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  const u = t.user as Record<string, unknown> | undefined;
  return (
    typeof t.access_token === "string" &&
    typeof t.expires_in === "number" &&
    typeof t.refresh_token === "string" &&
    /^[A-Za-z0-9_-]{20,200}$/.test(t.refresh_token) &&
    !!u &&
    typeof u.id === "string" &&
    typeof u.email === "string"
  );
}

// ------------------------------------------------------------------ auth

let refreshing: Promise<StoredAuth> | null = null;

export async function getAuth(): Promise<StoredAuth | null> {
  const a = await getLocal<StoredAuth>("auth");
  return a && typeof a.refreshToken === "string" && typeof a.userId === "string" ? a : null;
}

async function storeTokens(t: TokenOut): Promise<StoredAuth> {
  const prev = await getAuth();
  if (prev && prev.userId !== t.user.id) {
    // Account switch: nothing from the previous account may survive.
    await clearAccountData();
  }
  const auth: StoredAuth = { refreshToken: t.refresh_token, userId: t.user.id, email: t.user.email.slice(0, 320) };
  // Persist the rotated refresh token first: the old one is now consumed server-side.
  await setLocal("auth", auth);
  const access: StoredAccess = { token: t.access_token, expiresAt: Date.now() + Math.max(t.expires_in, 0) * 1000, userId: t.user.id };
  await setSession("access", access);
  return auth;
}

/** Sign out locally (no network). Used when the server says the session is gone. */
export async function signOutLocal(): Promise<void> {
  await clearAccountData();
  onSignedOut?.();
}

let onSignedOut: (() => void) | null = null;
export function setSignedOutHandler(fn: () => void): void {
  onSignedOut = fn;
}

async function exchange(refreshToken: string): Promise<TokenOut> {
  const res = await rawFetch("POST", "/api/v1/auth/refresh", { body: { refresh_token: refreshToken } });
  if (!res.ok) throw await parseError(res);
  const json: unknown = await res.json().catch(() => null);
  if (!isTokenOut(json)) throw new AppError("invalid_response", "The server returned an unexpected sign-in response.");
  return json;
}

/**
 * Single-flight refresh of the stored refresh token. Concurrent callers share one request, so a
 * rotated token is never presented twice by this worker. If the worker dies mid-request the next
 * attempt may present a consumed token; the server then answers refresh_reused and we sign out cleanly.
 */
export function refreshSession(): Promise<StoredAuth> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const auth = await getAuth();
    if (!auth) throw authRequired();
    try {
      return await storeTokens(await exchange(auth.refreshToken));
    } catch (e) {
      if (e instanceof AppError && e.status === 401 && SIGNED_OUT_CODES.has(e.code)) {
        await signOutLocal();
        throw authRequired(e.code === "refresh_reused" ? "Your session was revoked. Connect again from the Prepzy dashboard." : "Your session ended. Connect again from the Prepzy dashboard.");
      }
      throw e;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Exchange a refresh token handed over by the web app's connect page. */
export async function connectWithToken(token: string): Promise<StoredAuth> {
  if (refreshing) await refreshing.catch(() => undefined);
  const previous = await getAuth();
  const p = (async () => storeTokens(await exchange(token)))();
  refreshing = p;
  try {
    const auth = await p;
    // Revoke the replaced extension session (best effort) so it does not linger server-side.
    if (previous && previous.refreshToken !== auth.refreshToken) {
      rawFetch("POST", "/api/v1/auth/logout", { body: { refresh_token: previous.refreshToken } }).catch(() => undefined);
    }
    return auth;
  } finally {
    if (refreshing === p) refreshing = null;
  }
}

async function accessToken(): Promise<string> {
  const auth = await getAuth();
  if (!auth) throw authRequired();
  const a = await getSession<StoredAccess>("access");
  if (a && a.userId === auth.userId && a.expiresAt - SKEW_MS > Date.now()) return a.token;
  await refreshSession();
  const b = await getSession<StoredAccess>("access");
  if (!b) throw authRequired();
  return b.token;
}

export async function logout(): Promise<void> {
  if (refreshing) await refreshing.catch(() => undefined);
  const auth = await getAuth();
  if (auth) {
    try {
      const res = await rawFetch("POST", "/api/v1/auth/logout", { body: { refresh_token: auth.refreshToken } });
      void res;
    } catch {
      /* offline: still clear local data */
    }
  }
  await signOutLocal();
}

// ------------------------------------------------------------------ authenticated requests

export interface ApiResult<T> {
  status: number;
  data: T;
}

/** Authenticated JSON request. On 401 token_expired/invalid_token refreshes once and retries. */
export async function api<T = unknown>(method: Method, path: string, opts: { body?: unknown; idempotencyKey?: string } = {}): Promise<ApiResult<T>> {
  let token = await accessToken();
  let res = await rawFetch(method, path, { ...opts, token });
  if (res.status === 401) {
    const err = await parseError(res);
    if (err.code !== "token_expired" && err.code !== "invalid_token") throw err;
    await refreshSession();
    token = await accessToken();
    res = await rawFetch(method, path, { ...opts, token });
    if (res.status === 401) {
      await signOutLocal();
      throw authRequired();
    }
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return { status: 204, data: undefined as T };
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new AppError("invalid_response", "The server returned an unreadable response.", { requestId: res.headers.get("X-Request-ID") });
  }
  return { status: res.status, data: data as T };
}

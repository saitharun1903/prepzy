"use client";

/** Browser-side API access. Everything goes through this app's /api/proxy (cookies carry the session). */

export class ApiError extends Error {
  code: string;
  requestId: string | null;
  retryable: boolean;
  fields: Record<string, string>;
  status: number;
  extra: Record<string, unknown>;

  constructor(init: {
    status: number; code: string; message: string; requestId?: string | null; retryable?: boolean;
    fields?: Record<string, string>; extra?: Record<string, unknown>;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId ?? null;
    this.retryable = Boolean(init.retryable);
    this.fields = init.fields ?? {};
    this.extra = init.extra ?? {};
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export type Query = Record<string, string | number | boolean | null | undefined | Array<string | number>>;

export type ApiOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Query;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Return the raw Response (for downloads). */
  raw?: boolean;
};

export function buildQuery(q?: Query): string {
  if (!q) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, String(x)));
    else sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}

let onUnauthenticated: (() => void) | null = null;
export function setUnauthenticatedHandler(fn: (() => void) | null) {
  onUnauthenticated = fn;
}

/** Temporarily suppress the redirect to /login on 401 (e.g. while one-time recovery codes are on screen
 * after the session was deliberately ended). Requests still fail normally. */
let holdUnauthenticated = false;
export function holdUnauthenticatedRedirect(on: boolean) {
  holdUnauthenticated = on;
}

async function toError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const e = (body as { error?: Record<string, unknown> } | null)?.error;
  if (e && typeof e === "object") {
    const { code, message, request_id, retryable, fields, ...extra } = e as {
      code?: string; message?: string; request_id?: string | null; retryable?: boolean; fields?: Record<string, string>;
    } & Record<string, unknown>;
    return new ApiError({
      status: res.status, code: code || "error", message: message || `Request failed (${res.status}).`,
      requestId: request_id ?? res.headers.get("x-request-id"), retryable, fields: fields || {}, extra,
    });
  }
  return new ApiError({
    status: res.status, code: res.status === 404 ? "not_found" : "http_error",
    message: res.status >= 500 ? "The server had a problem handling this request." : `Request failed (${res.status}).`,
    requestId: res.headers.get("x-request-id"), retryable: res.status >= 500,
  });
}

export async function apiFetch<T = unknown>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method || "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") headers["X-Elevate-CSRF"] = "1";
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) {
    body = opts.body; // browser sets multipart boundary
  } else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const clean = path.replace(/^\/+/, "");
  let res: Response;
  try {
    res = await fetch(`/api/proxy/${clean}${buildQuery(opts.query)}`, {
      method, headers, body, signal: opts.signal, credentials: "same-origin", cache: "no-store",
    });
  } catch (e) {
    if ((e as Error)?.name === "AbortError") throw e;
    throw new ApiError({ status: 0, code: "network_error", message: "Could not reach Elevate. Check your connection.", retryable: true });
  }
  if (!res.ok) {
    const err = await toError(res);
    // The proxy only returns 401 when the session is unusable (it refreshes and retries first).
    if (res.status === 401 && !holdUnauthenticated) onUnauthenticated?.();
    throw err;
  }
  if (opts.raw) return res as unknown as T;
  if (res.status === 204) return null as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

/** POST to this app's own session routes (login/register/logout/extension-grant). */
export async function sessionPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/session/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Elevate-CSRF": "1", Accept: "application/json" },
      body: JSON.stringify(body ?? {}),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError({ status: 0, code: "network_error", message: "Could not reach Elevate. Check your connection.", retryable: true });
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return null as T;
  return (await res.json()) as T;
}

/** Download a file through the proxy and hand it to the browser as a save. */
export async function downloadFile(path: string, fallbackName: string, query?: Query): Promise<void> {
  const res = await apiFetch<Response>(path, { raw: true, query });
  const blob = await res.blob();
  const cd = res.headers.get("content-disposition") || "";
  const m = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function newIdempotencyKey(): string {
  return crypto.randomUUID();
}

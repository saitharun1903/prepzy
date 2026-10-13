// Service-worker behaviour against mocked chrome.* and fetch (not a browser runtime test).
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const EXT_ID = "bjhbbpnbmichlooillmiaeofcioofkni";
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const UI_SENDER = { id: EXT_ID, url: `${EXT_ORIGIN}/popup.html`, origin: EXT_ORIGIN };
const WEB_SENDER = { origin: "http://localhost:3000", url: "http://localhost:3000/extension/connect" };
const TAB_URL = "https://careers.example.test/jobs/42";
const JOB_ID = "3f2b7c1e-8a4d-4f6b-9c2e-1d5a7b9e0f12";

type Listener = (...a: unknown[]) => unknown;
const registered: Record<string, Listener[]> = {};
const ev = (name: string) => ({ addListener: (fn: Listener) => (registered[name] ??= []).push(fn) });

function area() {
  let data: Record<string, unknown> = {};
  return {
    get data() {
      return data;
    },
    get: async (k: string | string[]) => {
      const keys = Array.isArray(k) ? k : [k];
      return Object.fromEntries(keys.filter((x) => x in data).map((x) => [x, structuredClone(data[x])]));
    },
    set: async (o: Record<string, unknown>) => {
      data = { ...data, ...structuredClone(o) };
    },
    remove: async (k: string | string[]) => {
      for (const x of Array.isArray(k) ? k : [k]) delete data[x];
    },
    clear: async () => {
      data = {};
    },
    setAccessLevel: async () => undefined,
  };
}
const local = area();
const session = area();
const alarms = new Set<string>();
const badges: Record<string, string> = {};

interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}
const calls: Call[] = [];
let tokenCounter = 0;
const usedRefresh = new Set<string>();
let accessValid = new Set<string>();
let opState = "queued";

const newRefresh = () => `refresh_${String(++tokenCounter).padStart(4, "0")}_abcdefghijklmnop`;
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "X-Request-ID": "req-1", ...headers } });
const err = (status: number, code: string, message = code) => json(status, { error: { code, message, request_id: "req-err", retryable: false, fields: {} } });

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input));
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search, headers, body });
  if (url.origin !== "http://127.0.0.1:8000") throw new TypeError("unexpected host");
  if (url.pathname === "/api/v1/auth/refresh") {
    const t = (body as { refresh_token: string }).refresh_token;
    if (t === "revoked_token_abcdefghijklmnop" || usedRefresh.has(t)) return err(401, "refresh_reused", "Session revoked");
    usedRefresh.add(t);
    const access = `access_${tokenCounter}`;
    accessValid.add(access);
    return json(200, { access_token: access, expires_in: 900, refresh_token: newRefresh(), user: { id: "user-1", email: "me@example.test", display_name: null, is_admin: false, timezone: "UTC" } });
  }
  if (url.pathname === "/api/v1/auth/logout") return json(204, null);
  const auth = headers.Authorization?.replace("Bearer ", "") ?? "";
  if (!accessValid.has(auth)) return err(401, "token_expired", "Session expired");
  if (url.pathname === `/api/v1/jobs/${JOB_ID}`) return json(200, { job: { id: JOB_ID, title: "T", company: "C", saved: false }, analysis: null, history: [], active_operations: [] });
  if (url.pathname === "/api/v1/jobs/capture")
    return json(202, { job_id: JOB_ID, snapshot_id: "s1", operation_id: "op-1", analysis_id: null, reused_analysis: false, new_job: true, status_url: "/api/v1/operations/op-1" });
  if (url.pathname === "/api/v1/operations/op-1")
    return json(200, { id: "op-1", kind: "job_analysis", state: opState, stage: opState === "running" ? "analysing_requirements" : opState, attempt: 1, max_attempts: 3, terminal: false, error: null, result: null });
  return err(404, "not_found");
}

const extraction = {
  v: 1,
  href: TAB_URL,
  pageTitle: "Backend Engineer",
  readyState: "complete",
  capturedAt: new Date().toISOString(),
  adapter: "generic",
  jsonLd: { found: false, count: 0 },
  structured: null,
  title: "Backend Engineer",
  company: null,
  location: null,
  text: "Requirements: 4+ years building backend services in Java or Kotlin. ".repeat(5),
  textLength: 340,
  truncated: false,
  selection: null,
  attempts: 1,
};

beforeAll(async () => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: EXT_ID,
      getURL: (p: string) => `${EXT_ORIGIN}/${p}`,
      onInstalled: ev("onInstalled"),
      onStartup: ev("onStartup"),
      onMessage: ev("onMessage"),
      onMessageExternal: ev("onMessageExternal"),
    },
    storage: { local, session },
    alarms: {
      onAlarm: ev("onAlarm"),
      get: async (n: string) => (alarms.has(n) ? { name: n } : undefined),
      create: async (n: string) => void alarms.add(n),
      clear: async (n: string) => alarms.delete(n),
    },
    action: {
      setBadgeText: async (o: { tabId?: number; text: string }) => void (badges[String(o.tabId ?? "global")] = o.text),
      setBadgeBackgroundColor: async () => undefined,
    },
    tabs: { onRemoved: ev("tabs.onRemoved"), get: async (id: number) => ({ id, url: TAB_URL }) },
    scripting: { executeScript: async () => [{ frameId: 0, result: structuredClone(extraction) }] },
  };
  globalThis.fetch = fakeFetch as typeof fetch;
  await import("../src/background/sw");
});

beforeEach(() => {
  calls.length = 0;
});

function external(msg: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const keep = registered.onMessageExternal![0]!(msg, sender, resolve);
    if (keep !== true) setTimeout(() => resolve("ignored"), 10);
  });
}
function ui(msg: unknown, sender: unknown = UI_SENDER): Promise<any> {
  return new Promise((resolve) => {
    const keep = registered.onMessage![0]!(msg, sender, resolve);
    if (keep !== true) setTimeout(() => resolve("ignored"), 10);
  });
}

describe("service worker", () => {
  it("ignores connect messages from other origins", async () => {
    const r = await external({ type: "elevate.connect.v1", refresh_token: "web_issued_token_abcdefghijk" }, { origin: "https://evil.example", url: "https://evil.example/" });
    expect(r).toBe("ignored");
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed connect messages from the web origin", async () => {
    const r = (await external({ type: "elevate.connect.v1", refresh_token: "short" }, WEB_SENDER)) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("connects: exchanges the token and stores the ROTATED refresh token", async () => {
    const r = (await external({ type: "elevate.connect.v1", refresh_token: "web_issued_token_abcdefghijk" }, WEB_SENDER)) as { ok: boolean; email: string };
    expect(r).toEqual({ ok: true, email: "me@example.test" });
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/auth/refresh"]);
    const auth = local.data.auth as { refreshToken: string; userId: string };
    expect(auth.refreshToken).not.toBe("web_issued_token_abcdefghijk");
    expect(auth.refreshToken).toMatch(/^refresh_/);
    expect(auth.userId).toBe("user-1");
    expect((session.data.access as { token: string }).token).toMatch(/^access_/);
  });

  it("rejects UI messages from content scripts / web pages", async () => {
    const r = await ui({ v: 1, type: "auth.logout" }, { id: EXT_ID, url: TAB_URL, tab: { id: 5 } });
    expect(r).toBe("ignored");
    expect(local.data.auth).toBeDefined();
  });

  it("rejects malformed UI messages", async () => {
    const r = await ui({ v: 1, type: "job.get", jobId: "../../admin" });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("bad_message");
  });

  it("refreshes once on token_expired and retries; concurrent callers share one refresh", async () => {
    accessValid = new Set(); // every current access token is now expired server-side
    const before = (local.data.auth as { refreshToken: string }).refreshToken;
    const [a, b] = await Promise.all([ui({ v: 1, type: "job.get", jobId: JOB_ID }), ui({ v: 1, type: "job.get", jobId: JOB_ID })]);
    expect(a.ok && b.ok).toBe(true);
    const refreshes = calls.filter((c) => c.path === "/api/v1/auth/refresh");
    expect(refreshes).toHaveLength(1);
    expect((refreshes[0]!.body as { refresh_token: string }).refresh_token).toBe(before);
    expect((local.data.auth as { refreshToken: string }).refreshToken).not.toBe(before);
  });

  it("captures: reads the page, submits with an Idempotency-Key and tracks the operation", async () => {
    const ext = await ui({ v: 1, type: "page.extract", tabId: 5 });
    expect(ext.ok).toBe(true);
    const captureId = "11111111-2222-4333-8444-555555555555";
    const sub = await ui({ v: 1, type: "capture.submit", captureId, tabId: 5, source: "page", manualText: null, title: "Backend Engineer", company: null, save: true });
    expect(sub.ok).toBe(true);
    expect(sub.data.state).toBe("queued");
    const post = calls.find((c) => c.path === "/api/v1/jobs/capture")!;
    expect(post.headers["Idempotency-Key"]).toBe(captureId);
    expect(post.body).toMatchObject({ method: "extension", save: true, source: { url: TAB_URL, adapter: "generic" } });
    expect(badges["5"]).toBe("…");
    expect(alarms.has("elevate.poll")).toBe(true);

    // The same tab + URL sees the record; a different tab does not.
    const same = await ui({ v: 1, type: "state.get", tabId: 5, url: `${TAB_URL}#apply` });
    expect(same.data.record?.captureId).toBe(captureId);
    const other = await ui({ v: 1, type: "state.get", tabId: 6, url: TAB_URL });
    expect(other.data.record).toBeNull();

    opState = "running";
    const polled = await ui({ v: 1, type: "capture.poll", captureId });
    expect(polled.data.state).toBe("analyzing");
    expect(polled.data.stage).toBe("analysing_requirements");

    // Double submit with the same capture id does not create a second capture.
    calls.length = 0;
    await ui({ v: 1, type: "capture.submit", captureId, tabId: 5, source: "page", manualText: null, title: null, company: null, save: false });
    expect(calls.filter((c) => c.path === "/api/v1/jobs/capture")).toHaveLength(0);
  });

  it("signs out cleanly when the server reports refresh token reuse", async () => {
    accessValid = new Set();
    await local.set({ auth: { refreshToken: "revoked_token_abcdefghijklmnop", userId: "user-1", email: "me@example.test" } });
    const r = await ui({ v: 1, type: "job.get", jobId: JOB_ID });
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("auth_required");
    expect(local.data.auth).toBeUndefined();
    expect(session.data.captures).toBeUndefined();
    expect(alarms.has("elevate.poll")).toBe(false);
  });

  it("logout revokes server-side and clears all account data", async () => {
    await external({ type: "elevate.connect.v1", refresh_token: "web_issued_token_second_abcdef" }, WEB_SENDER);
    const token = (local.data.auth as { refreshToken: string }).refreshToken;
    calls.length = 0;
    const r = await ui({ v: 1, type: "auth.logout" });
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/v1/auth/logout", body: { refresh_token: token } });
    expect(Object.keys(local.data)).toHaveLength(0);
    expect(Object.keys(session.data)).toHaveLength(0);
    const st = await ui({ v: 1, type: "state.get", tabId: 5, url: TAB_URL });
    expect(st.data.signedIn).toBe(false);
  });
});

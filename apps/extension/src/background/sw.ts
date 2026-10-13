// Elevate service worker (MV3, module). Ephemeral: every listener is registered synchronously at
// top level, and all state lives in chrome.storage so work resumes after the worker is stopped.

import type { components } from "@elevate/api-client";
import { CONNECT_ORIGINS, WEB_BASE } from "../config";
import { extractJobPage, validateExtraction, verdictFor, MIN_TEXT, type ExtractResult } from "../shared/extract";
import { toApplicationView, toJobView, toLookupView, toMatchView, type ApplicationView, type LookupView } from "../shared/jobview";
import {
  isAllowedConnectSender,
  isTrustedUiSender,
  validateConnectMessage,
  validateUiRequest,
  type ReplyMap,
  type StateData,
  type UiRequest,
} from "../shared/messages";
import { isTerminal, recordMatches, toOperationView, applyOperation, type CaptureRecord } from "../shared/state";
import { classifyUrl, normalizeUrl } from "../shared/url";
import { api, connectWithToken, getAuth, logout, setSignedOutHandler } from "./api";
import {
  allCaptures,
  detachTab,
  getCapture,
  insertCapture,
  issueStamp,
  pollAllActive,
  pollCapture,
  POLL_ALARM,
  removeCapture,
  syncAlarm,
  updateCapture,
} from "./captures";
import { AppError, authRequired, toErrorInfo } from "./errors";
import { getSession, removeSession, restrictStorageAccess, setSession } from "./storage";

const EXT_ORIGIN = chrome.runtime.getURL("").replace(/\/+$/, "");
const LOOKUP_TTL_MS = 60_000;

interface StoredExtraction {
  url: string;
  result: ExtractResult;
}

setSignedOutHandler(() => {
  void chrome.alarms.clear(POLL_ALARM);
  void chrome.action.setBadgeText({ text: "" }).catch(() => undefined);
});

// ------------------------------------------------------------------ lifecycle

chrome.runtime.onInstalled.addListener(() => {
  void restrictStorageAccess();
  void syncAlarm().catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void restrictStorageAccess();
  void syncAlarm().catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== POLL_ALARM) return;
  void (async () => {
    const auth = await getAuth();
    if (!auth) {
      await chrome.alarms.clear(POLL_ALARM);
      return;
    }
    await pollAllActive(auth.userId);
  })().catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void detachTab(tabId).catch(() => undefined);
  void removeSession([`extract:${tabId}`, `draft:${tabId}`]).catch(() => undefined);
});

// ------------------------------------------------------------------ external: web app connect

chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (!isAllowedConnectSender(sender, CONNECT_ORIGINS)) return false; // silently ignore other origins
  const m = validateConnectMessage(msg);
  if (!m) {
    sendResponse({ ok: false, error: { code: "bad_message", message: "Unsupported message." } });
    return false;
  }
  connectWithToken(m.refresh_token).then(
    (auth) => sendResponse({ ok: true, email: auth.email }),
    (e) => {
      const info = toErrorInfo(e);
      sendResponse({ ok: false, error: { code: info.code, message: info.message, request_id: info.requestId } });
    },
  );
  return true;
});

// ------------------------------------------------------------------ internal: popup / side panel

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!isTrustedUiSender(sender, chrome.runtime.id, EXT_ORIGIN)) return false;
  const req = validateUiRequest(msg);
  if (!req) {
    sendResponse({ ok: false, error: { code: "bad_message", message: "Rejected an invalid message.", requestId: null, retryable: false } });
    return false;
  }
  handle(req).then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: toErrorInfo(e) }),
  );
  return true;
});

async function requireAuth() {
  const auth = await getAuth();
  if (!auth) throw authRequired();
  return auth;
}

async function ownCapture(captureId: string): Promise<CaptureRecord> {
  const auth = await requireAuth();
  const rec = await getCapture(captureId);
  if (!rec || rec.accountId !== auth.userId) throw new AppError("not_found", "This capture is no longer available.");
  return rec;
}

async function handle(req: UiRequest): Promise<ReplyMap[keyof ReplyMap]> {
  switch (req.type) {
    case "state.get":
      return getState(req.tabId, req.url);
    case "auth.logout":
      await logout();
      return { signedOut: true };
    case "page.extract":
      return extract(req.tabId);
    case "page.lookup":
      return { job: await lookup(req.url) };
    case "capture.submit":
      return submit(req);
    case "capture.poll": {
      await ownCapture(req.captureId);
      const rec = await pollCapture(req.captureId);
      if (!rec) throw new AppError("not_found", "This capture is no longer available.");
      return rec;
    }
    case "capture.cancel":
      return operationAction(req.captureId, "cancel");
    case "capture.retry":
      return operationAction(req.captureId, "retry");
    case "capture.dismiss":
      await ownCapture(req.captureId);
      await removeCapture(req.captureId);
      return { dismissed: true };
    case "job.get": {
      const { data } = await api("GET", `/api/v1/jobs/${req.jobId}`);
      const view = toJobView(data);
      if (!view) throw new AppError("invalid_response", "The server returned an unexpected job.");
      return view;
    }
    case "job.save":
      await api(req.saved ? "POST" : "DELETE", `/api/v1/jobs/${req.jobId}/save`);
      await setSession("lookupCache", {});
      return { saved: req.saved };
    case "job.note":
      await api("POST", `/api/v1/jobs/${req.jobId}/notes`, { body: { body: req.body } satisfies components["schemas"]["NoteIn"] });
      return { created: true };
    case "job.reminder": {
      const { data } = await api<Record<string, unknown>>("POST", "/api/v1/reminders", {
        body: { title: req.title.trim(), job_id: req.jobId, due_date: req.dueDate, remind_time: req.remindTime } satisfies components["schemas"]["ReminderIn"],
      });
      return { note: typeof data?.note === "string" ? data.note.slice(0, 300) : null };
    }
    case "job.match": {
      // Deterministic server-side comparison with the default resume; identical inputs reuse the
      // existing report, so calling this on every result view is cheap.
      try {
        const { data } = await api("POST", `/api/v1/jobs/${req.jobId}/match`, { body: {} });
        return { match: toMatchView(data) };
      } catch (e) {
        if (e instanceof AppError && (e.code === "no_analysis" || e.code === "not_parsed")) return { match: null };
        throw e;
      }
    }
    case "job.applications":
      return { current: await currentApplication(req.jobId) };
    case "job.application.set":
      return { current: await setApplication(req.jobId, req.status) };
  }
}

// ------------------------------------------------------------------ state

async function getState(tabId: number | null, url: string | null): Promise<StateData> {
  const auth = await getAuth();
  if (!auth) return { signedIn: false, email: null, record: null, recent: [], extraction: null, webBase: WEB_BASE };
  const norm = normalizeUrl(url);
  const mine = (await allCaptures()).filter((r) => r.accountId === auth.userId).sort((a, b) => b.updatedAt - a.updatedAt);
  const record = mine.find((r) => recordMatches(r, tabId, norm, auth.userId)) ?? null;
  const recent = mine.filter((r) => r !== record).slice(0, 4);
  let extraction: StateData["extraction"] = null;
  if (tabId !== null && norm) {
    const ext = await getSession<StoredExtraction>(`extract:${tabId}`);
    if (ext && ext.url === norm) extraction = { extractionUrl: ext.url, result: ext.result };
  }
  return { signedIn: true, email: auth.email, record, recent, extraction, webBase: WEB_BASE };
}

// ------------------------------------------------------------------ extraction

function mapScriptingError(e: unknown): AppError {
  const msg = e instanceof Error ? e.message : String(e);
  if (/cannot be scripted|cannot access a chrome|chrome:\/\/|edge:\/\/|extensions gallery|webstore/i.test(msg)) {
    return new AppError("restricted", "This page is protected by the browser and cannot be read. Paste the job text instead.");
  }
  if (/permission|cannot access contents|host/i.test(msg)) {
    return new AppError("no_access", "Elevate can read a page only after you click the Elevate toolbar button while that page is open.");
  }
  if (/frame|tab was closed|no tab/i.test(msg)) {
    return new AppError("tab_gone", "The tab changed or was closed. Try again.");
  }
  return new AppError("extract_failed", "This page could not be read. Paste the job text instead.");
}

async function extract(tabId: number): Promise<ExtractResult> {
  await requireAuth();
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new AppError("tab_gone", "The tab was closed.");
  }
  const access = classifyUrl(tab.url ?? null);
  if (access.kind === "restricted" || access.kind === "pdf") throw new AppError("restricted", access.reason);
  if (access.kind === "unknown") throw new AppError("no_access", access.reason);
  let results: chrome.scripting.InjectionResult<unknown>[];
  try {
    results = (await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: "ISOLATED",
      func: extractJobPage,
      args: [{ attempts: 3, delayMs: 700, layout: true }],
    })) as chrome.scripting.InjectionResult<unknown>[];
  } catch (e) {
    throw mapScriptingError(e);
  }
  const first = results.find((r) => r.frameId === 0) ?? results[0];
  const result = validateExtraction(first?.result);
  if (!result) throw new AppError("extract_failed", "The page returned data Elevate could not use. Paste the job text instead.");
  const tabNow = await chrome.tabs.get(tabId).catch(() => null);
  const norm = normalizeUrl(tabNow?.url ?? null);
  if (!norm || norm !== normalizeUrl(result.href)) {
    throw new AppError("page_changed", "The page changed while it was being read. Try again.");
  }
  await setSession(`extract:${tabId}`, { url: norm, result } satisfies StoredExtraction);
  return result;
}

// ------------------------------------------------------------------ lookup

async function lookup(url: string): Promise<LookupView | null> {
  await requireAuth();
  const norm = normalizeUrl(url);
  if (!norm) return null;
  const cache = (await getSession<Record<string, { at: number; job: LookupView | null }>>("lookupCache")) ?? {};
  const hit = cache[norm];
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.job;
  const { data } = await api("GET", `/api/v1/jobs/lookup?url=${encodeURIComponent(url.slice(0, 4000))}`);
  const job = toLookupView(data);
  const fresh = Object.fromEntries(Object.entries(cache).filter(([, v]) => Date.now() - v.at < LOOKUP_TTL_MS).slice(-30));
  fresh[norm] = { at: Date.now(), job };
  await setSession("lookupCache", fresh);
  return job;
}

// ------------------------------------------------------------------ capture

async function submit(req: Extract<UiRequest, { type: "capture.submit" }>): Promise<CaptureRecord> {
  const auth = await requireAuth();
  const existing = await getCapture(req.captureId);
  if (existing && existing.accountId === auth.userId) return existing; // double submit: same capture

  let text: string;
  let href: string | null = null;
  let norm = "";
  let pageTitle: string | null = null;
  let adapter = "manual";
  let capturedAt = new Date().toISOString();
  let structured: Record<string, unknown> | null = null;

  const ext = req.tabId !== null ? await getSession<StoredExtraction>(`extract:${req.tabId}`) : undefined;
  let tabUrl: string | null = null;
  if (req.tabId !== null) {
    const tab = await chrome.tabs.get(req.tabId).catch(() => null);
    if (!tab) throw new AppError("tab_gone", "The tab was closed.");
    tabUrl = tab.url ?? null;
  }

  if (req.source === "manual") {
    text = req.manualText ?? "";
    const n = normalizeUrl(tabUrl);
    if (n && classifyUrl(tabUrl).kind === "ok") {
      href = tabUrl;
      norm = n;
      pageTitle = ext && ext.url === n ? ext.result.pageTitle : null;
    }
  } else {
    if (!ext) throw new AppError("not_extracted", "Read the page first.");
    // The page must still be the one that was read (tab id AND normalised URL).
    if (!tabUrl || normalizeUrl(tabUrl) !== ext.url) {
      throw new AppError("page_changed", "This tab now shows a different page. Read the page again.");
    }
    const r = ext.result;
    if (req.source === "selection") {
      if (!r.selection) throw new AppError("no_selection", "No selected text was found. Select the job text on the page and read it again.");
      text = r.selection;
      adapter = "selection";
    } else {
      const v = verdictFor(r);
      if (v.kind === "multiple") {
        throw new AppError("multiple_jobs", `This page lists ${v.count} jobs. Select one job's text on the page, or paste it.`);
      }
      text = r.text;
      adapter = r.adapter;
      structured = r.structured;
    }
    href = r.href;
    norm = ext.url;
    pageTitle = r.pageTitle || null;
    capturedAt = r.capturedAt;
  }
  if (text.trim().length < MIN_TEXT) {
    throw new AppError("too_short", `The job text is too short (at least ${MIN_TEXT} characters are needed). Paste the full posting.`);
  }

  // Typed against the generated OpenAPI schema (packages/api-client).
  const body: components["schemas"]["CaptureIn"] = {
    method: req.source === "manual" ? "manual" : "extension",
    text,
    title: req.title?.trim() || null,
    company: req.company?.trim() || null,
    source: { url: href, page_title: pageTitle, captured_at: capturedAt, adapter },
    structured,
    save: req.save,
  };
  const { data } = await api<Record<string, unknown>>("POST", "/api/v1/jobs/capture", { body, idempotencyKey: req.captureId });
  const jobId = typeof data?.job_id === "string" ? data.job_id : null;
  if (!jobId) throw new AppError("invalid_response", "The server returned an unexpected capture response.");
  const operationId = typeof data.operation_id === "string" ? data.operation_id : null;
  const analysisId = typeof data.analysis_id === "string" ? data.analysis_id : null;
  const now = Date.now();
  const rec: CaptureRecord = {
    captureId: req.captureId,
    operationId,
    jobId,
    analysisId,
    tabId: req.tabId,
    url: norm,
    accountId: auth.userId,
    state: operationId ? "queued" : "completed",
    stage: operationId ? "queued" : null,
    attempt: 0,
    maxAttempts: 0,
    error: null,
    connection: "ok",
    title: body.title ?? null,
    startedAt: now,
    updatedAt: now,
    appliedAt: 0,
    seq: 1,
  };
  await setSession("lookupCache", {});
  await removeSession(req.tabId !== null ? `draft:${req.tabId}` : []);
  return insertCapture(rec);
}

async function operationAction(captureId: string, action: "cancel" | "retry"): Promise<CaptureRecord> {
  const rec = await ownCapture(captureId);
  if (!rec.operationId) throw new AppError("not_retryable", "There is no server operation for this capture.");
  if (action === "cancel" && isTerminal(rec.state)) return rec;
  const issuedAt = issueStamp();
  const { data } = await api("POST", `/api/v1/operations/${encodeURIComponent(rec.operationId)}/${action}`);
  const op = toOperationView(data);
  if (!op) throw new AppError("invalid_response", "The server returned an unexpected operation status.");
  const next = await updateCapture(captureId, (r) => applyOperation(r, op, issuedAt, Date.now()));
  if (!next) throw new AppError("not_found", "This capture is no longer available.");
  return next;
}

// ------------------------------------------------------------------ applications

async function currentApplication(jobId: string): Promise<ApplicationView | null> {
  const { data } = await api<unknown[]>("GET", `/api/v1/jobs/${jobId}/applications`);
  const first = Array.isArray(data) ? data[0] : null;
  return first ? toApplicationView(first) : null;
}

async function setApplication(jobId: string, status: "planned" | "applied"): Promise<ApplicationView> {
  const current = await currentApplication(jobId);
  if (!current) {
    const { data } = await api("POST", "/api/v1/applications", { body: { job_id: jobId, status, reapply: false } satisfies components["schemas"]["ApplicationIn"] });
    const v = toApplicationView(data);
    if (!v) throw new AppError("invalid_response", "The server returned an unexpected application.");
    return v;
  }
  if (current.status === status) return current;
  const { data } = await api("PATCH", `/api/v1/applications/${encodeURIComponent(current.id)}`, {
    body: { expected_version: current.version, status, correction: false, clear_next_action: false } satisfies components["schemas"]["ApplicationPatch"],
  });
  const v = toApplicationView(data);
  if (!v) throw new AppError("invalid_response", "The server returned an unexpected application.");
  return v;
}

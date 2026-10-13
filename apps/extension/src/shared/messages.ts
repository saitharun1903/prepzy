// Typed, versioned messages between extension pages (popup / side panel) and the service worker,
// plus the external "connect" message from the web app. Hand-written validators (unit-tested).

import type { CaptureRecord } from "./state";
import type { ExtractResult } from "./extract";
import type { ApplicationView, JobView, LookupView, MatchView } from "./jobview";
import { isUuid } from "./url";

export const PROTOCOL = 1 as const;

export type TextSource = "page" | "selection" | "manual";
export type AppStatus = "planned" | "applied";

export type UiRequest =
  | { v: 1; type: "state.get"; tabId: number | null; url: string | null }
  | { v: 1; type: "auth.logout" }
  | { v: 1; type: "page.extract"; tabId: number }
  | { v: 1; type: "page.lookup"; url: string }
  | {
      v: 1;
      type: "capture.submit";
      captureId: string;
      tabId: number | null;
      source: TextSource;
      manualText: string | null;
      title: string | null;
      company: string | null;
      save: boolean;
    }
  | { v: 1; type: "capture.poll"; captureId: string }
  | { v: 1; type: "capture.cancel"; captureId: string }
  | { v: 1; type: "capture.retry"; captureId: string }
  | { v: 1; type: "capture.dismiss"; captureId: string }
  | { v: 1; type: "job.get"; jobId: string }
  | { v: 1; type: "job.match"; jobId: string }
  | { v: 1; type: "job.save"; jobId: string; saved: boolean }
  | { v: 1; type: "job.note"; jobId: string; body: string }
  | { v: 1; type: "job.reminder"; jobId: string; title: string; dueDate: string; remindTime: string }
  | { v: 1; type: "job.applications"; jobId: string }
  | { v: 1; type: "job.application.set"; jobId: string; status: AppStatus };

export type UiRequestType = UiRequest["type"];

export interface ErrorInfo {
  code: string;
  message: string;
  requestId: string | null;
  retryable: boolean;
}

export type Reply<T> = { ok: true; data: T } | { ok: false; error: ErrorInfo };

export interface StateData {
  signedIn: boolean;
  email: string | null;
  record: CaptureRecord | null;
  recent: CaptureRecord[];
  extraction: { extractionUrl: string; result: ExtractResult } | null;
  webBase: string;
}

export interface ReplyMap {
  "state.get": StateData;
  "auth.logout": { signedOut: true };
  "page.extract": ExtractResult;
  "page.lookup": { job: LookupView | null };
  "capture.submit": CaptureRecord;
  "capture.poll": CaptureRecord;
  "capture.cancel": CaptureRecord;
  "capture.retry": CaptureRecord;
  "capture.dismiss": { dismissed: true };
  "job.get": JobView;
  "job.match": { match: MatchView | null };
  "job.save": { saved: boolean };
  "job.note": { created: true };
  "job.reminder": { note: string | null };
  "job.applications": { current: ApplicationView | null };
  "job.application.set": { current: ApplicationView };
}

// ----------------------------------------------------------------- validators

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const isTabId = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2 ** 31;
const isStr = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.length >= min && v.length <= max;
const isOptStr = (v: unknown, max: number): v is string | null => v === null || isStr(v, 0, max);
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function hasOnly(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).every((k) => keys.includes(k));
}

/** Validate an incoming UI message. Returns the typed message or null (rejected). */
export function validateUiRequest(m: unknown): UiRequest | null {
  if (!isObj(m) || m.v !== PROTOCOL || typeof m.type !== "string") return null;
  const k = (...keys: string[]) => hasOnly(m, ["v", "type", ...keys]);
  switch (m.type) {
    case "state.get":
      return k("tabId", "url") && (m.tabId === null || isTabId(m.tabId)) && isOptStr(m.url, 4000) ? (m as UiRequest) : null;
    case "auth.logout":
      return k() ? (m as UiRequest) : null;
    case "page.extract":
      return k("tabId") && isTabId(m.tabId) ? (m as UiRequest) : null;
    case "page.lookup":
      return k("url") && isStr(m.url, 8, 4000) ? (m as UiRequest) : null;
    case "capture.submit": {
      if (!k("captureId", "tabId", "source", "manualText", "title", "company", "save")) return null;
      if (!isUuid(m.captureId)) return null;
      if (!(m.tabId === null || isTabId(m.tabId))) return null;
      if (m.source !== "page" && m.source !== "selection" && m.source !== "manual") return null;
      if (m.source === "manual" ? !isStr(m.manualText, 1, 60_000) : m.manualText !== null) return null;
      if (m.source !== "manual" && m.tabId === null) return null;
      if (!isOptStr(m.title, 300) || !isOptStr(m.company, 300) || typeof m.save !== "boolean") return null;
      return m as UiRequest;
    }
    case "capture.poll":
    case "capture.cancel":
    case "capture.retry":
    case "capture.dismiss":
      return k("captureId") && isUuid(m.captureId) ? (m as UiRequest) : null;
    case "job.get":
    case "job.match":
    case "job.applications":
      return k("jobId") && isUuid(m.jobId) ? (m as UiRequest) : null;
    case "job.save":
      return k("jobId", "saved") && isUuid(m.jobId) && typeof m.saved === "boolean" ? (m as UiRequest) : null;
    case "job.note":
      return k("jobId", "body") && isUuid(m.jobId) && isStr(m.body, 1, 20_000) && m.body.trim().length > 0 ? (m as UiRequest) : null;
    case "job.reminder":
      return k("jobId", "title", "dueDate", "remindTime") &&
        isUuid(m.jobId) &&
        isStr(m.title, 1, 300) &&
        m.title.trim().length > 0 &&
        typeof m.dueDate === "string" &&
        DATE.test(m.dueDate) &&
        typeof m.remindTime === "string" &&
        TIME.test(m.remindTime)
        ? (m as UiRequest)
        : null;
    case "job.application.set":
      return k("jobId", "status") && isUuid(m.jobId) && (m.status === "planned" || m.status === "applied") ? (m as UiRequest) : null;
    default:
      return null;
  }
}

/** Minimal shape of chrome.runtime.MessageSender used for checks (keeps this module chrome-free). */
export interface SenderLike {
  id?: string;
  url?: string;
  origin?: string;
  tab?: unknown;
}

/**
 * Privileged UI messages must come from this extension's own pages (popup, side panel), never from
 * content scripts (whose sender.url is the web page's URL) or other extensions.
 */
export function isTrustedUiSender(sender: SenderLike, runtimeId: string, extensionOrigin: string): boolean {
  if (!sender || sender.id !== runtimeId) return false;
  const origin = extensionOrigin.replace(/\/+$/, "");
  if (typeof sender.url !== "string" || !sender.url.startsWith(origin + "/")) return false;
  if (sender.origin !== undefined && sender.origin !== origin) return false;
  return true;
}

// ----------------------------------------------------------------- external connect message

export interface ConnectMessage {
  type: "elevate.connect.v1";
  refresh_token: string;
}

const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

export function validateConnectMessage(m: unknown): ConnectMessage | null {
  if (!isObj(m)) return null;
  if (!hasOnly(m, ["type", "refresh_token"])) return null;
  if (m.type !== "elevate.connect.v1") return null;
  if (typeof m.refresh_token !== "string" || !TOKEN.test(m.refresh_token)) return null;
  return { type: "elevate.connect.v1", refresh_token: m.refresh_token };
}

/** The web page origin must be one of the configured connect origins (exact match). */
export function isAllowedConnectSender(sender: SenderLike, allowedOrigins: readonly string[]): boolean {
  if (!sender || typeof sender.origin !== "string") return false;
  if (!allowedOrigins.includes(sender.origin)) return false;
  if (typeof sender.url === "string") {
    try {
      if (new URL(sender.url).origin !== sender.origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

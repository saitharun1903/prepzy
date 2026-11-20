// Capture records: persistence, restart recovery, polling and the action badge.

import { applyOperation, badgeFor, isActive, isTerminal, toOperationView, type CaptureRecord } from "../shared/state";
import { glowModeFor, showGlow } from "./glow";
import { api } from "./api";
import { AppError } from "./errors";
import { createLock, getLocal, getSession, setLocal, setSession } from "./storage";

export const POLL_ALARM = "elevate.poll";
const MAX_RECORDS = 25;
const KEEP_TERMINAL_MS = 24 * 60 * 60 * 1000;

type MirrorRecord = Pick<
  CaptureRecord,
  "captureId" | "operationId" | "jobId" | "tabId" | "url" | "accountId" | "state" | "stage" | "startedAt" | "updatedAt"
>;

const withLock = createLock();

function fromMirror(m: MirrorRecord): CaptureRecord {
  return {
    ...m,
    // Tab ids are not stable across browser restarts: an orphaned record is never shown as the
    // current page's result; it is only listed under "Recent".
    tabId: null,
    analysisId: null,
    attempt: 0,
    maxAttempts: 0,
    error: null,
    connection: "ok",
    title: null,
    appliedAt: 0,
    seq: 0,
  };
}

function isMirror(x: unknown): x is MirrorRecord {
  if (!x || typeof x !== "object") return false;
  const m = x as Record<string, unknown>;
  return typeof m.captureId === "string" && typeof m.jobId === "string" && typeof m.state === "string" && typeof m.accountId === "string";
}

async function load(): Promise<Record<string, CaptureRecord>> {
  const current = await getSession<Record<string, CaptureRecord>>("captures");
  if (current) return current;
  // Session storage is empty after a browser restart or extension reload: recover from the mirror.
  const mirror = (await getLocal<unknown[]>("capturesMirror")) ?? [];
  const out: Record<string, CaptureRecord> = {};
  for (const m of Array.isArray(mirror) ? mirror : []) if (isMirror(m)) out[m.captureId] = fromMirror(m);
  await setSession("captures", out);
  return out;
}

function prune(map: Record<string, CaptureRecord>, now: number): Record<string, CaptureRecord> {
  const list = Object.values(map)
    .filter((r) => !(isTerminal(r.state) && now - r.updatedAt > KEEP_TERMINAL_MS))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_RECORDS);
  return Object.fromEntries(list.map((r) => [r.captureId, r]));
}

async function save(map: Record<string, CaptureRecord>): Promise<void> {
  const pruned = prune(map, Date.now());
  await setSession("captures", pruned);
  const mirror: MirrorRecord[] = Object.values(pruned).map((r) => ({
    captureId: r.captureId,
    operationId: r.operationId,
    jobId: r.jobId,
    tabId: r.tabId,
    url: r.url,
    accountId: r.accountId,
    state: r.state,
    stage: r.stage,
    startedAt: r.startedAt,
    updatedAt: r.updatedAt,
  }));
  await setLocal("capturesMirror", mirror);
}

export async function allCaptures(): Promise<CaptureRecord[]> {
  return Object.values(await load());
}

export async function getCapture(id: string): Promise<CaptureRecord | null> {
  return (await load())[id] ?? null;
}

/** Insert a new record, replacing any earlier record for the same tab + URL. */
export function insertCapture(rec: CaptureRecord): Promise<CaptureRecord> {
  return withLock(async () => {
    const map = await load();
    for (const r of Object.values(map)) {
      if (r.captureId !== rec.captureId && r.tabId !== null && r.tabId === rec.tabId && r.url === rec.url) delete map[r.captureId];
    }
    map[rec.captureId] = rec;
    await save(map);
    await afterChange(rec);
    return rec;
  });
}

/** Read-modify-write under the lock. `fn` returning null means "no change" (e.g. stale response). */
export function updateCapture(id: string, fn: (r: CaptureRecord) => CaptureRecord | null): Promise<CaptureRecord | null> {
  return withLock(async () => {
    const map = await load();
    const cur = map[id];
    if (!cur) return null;
    const next = fn(cur);
    if (!next) return cur;
    map[id] = next;
    await save(map);
    await afterChange(next);
    return next;
  });
}

export function removeCapture(id: string): Promise<void> {
  return withLock(async () => {
    const map = await load();
    const cur = map[id];
    delete map[id];
    await save(map);
    if (cur?.tabId != null) await setBadge(cur.tabId, "");
    await syncAlarm(Object.values(map));
  });
}

export function detachTab(tabId: number): Promise<void> {
  return withLock(async () => {
    const map = await load();
    let changed = false;
    for (const r of Object.values(map)) {
      if (r.tabId === tabId) {
        map[r.captureId] = { ...r, tabId: null, seq: r.seq + 1 };
        changed = true;
      }
    }
    if (changed) await save(map);
  });
}

async function setBadge(tabId: number, text: string, color?: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    /* the tab may have been closed */
  }
}

async function afterChange(rec: CaptureRecord): Promise<void> {
  if (rec.tabId !== null) {
    const b = badgeFor(rec.state);
    await setBadge(rec.tabId, b.text, b.color);
    const mode = glowModeFor(rec.state);
    if (mode) void showGlow(rec.tabId, mode);
  }
  await syncAlarm(Object.values(await load()));
}

/** chrome.alarms keeps tracking alive across service-worker restarts (30 s is the MV3 minimum). */
export async function syncAlarm(records?: CaptureRecord[]): Promise<void> {
  const recs = records ?? (await allCaptures());
  const active = recs.some((r) => isActive(r.state) && r.operationId);
  const existing = await chrome.alarms.get(POLL_ALARM);
  if (active && !existing) await chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5, delayInMinutes: 0.5 });
  if (!active && existing) await chrome.alarms.clear(POLL_ALARM);
}

// ------------------------------------------------------------------ polling

let lastIssued = 0;
/** Strictly increasing issue stamps so out-of-order responses can be recognised as stale. */
export function issueStamp(): number {
  lastIssued = Math.max(Date.now(), lastIssued + 1);
  return lastIssued;
}

const inflight = new Map<string, Promise<CaptureRecord | null>>();

/** Poll one capture's operation. Deduplicated: UI polling and the alarm share in-flight requests. */
export function pollCapture(id: string): Promise<CaptureRecord | null> {
  const existing = inflight.get(id);
  if (existing) return existing;
  const p = (async () => {
    const rec = await getCapture(id);
    if (!rec || !rec.operationId || !isActive(rec.state)) return rec;
    const issuedAt = issueStamp();
    let json: unknown;
    try {
      json = (await api("GET", `/api/v1/operations/${encodeURIComponent(rec.operationId)}`)).data;
    } catch (e) {
      if (e instanceof AppError && e.code === "network_error") {
        return updateCapture(id, (r) => (r.connection === "lost" ? null : { ...r, connection: "lost", seq: r.seq + 1 }));
      }
      if (e instanceof AppError && e.status === 404) {
        return updateCapture(id, (r) => ({
          ...r,
          state: "failed",
          error: { code: "not_found", message: "The server no longer knows this analysis.", requestId: e.requestId },
          updatedAt: Date.now(),
          seq: r.seq + 1,
        }));
      }
      throw e;
    }
    const op = toOperationView(json);
    if (!op) throw new AppError("invalid_response", "The server returned an unexpected operation status.");
    return updateCapture(id, (r) => applyOperation(r, op, issuedAt, Date.now()));
  })().finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

export async function pollAllActive(accountId: string): Promise<void> {
  const recs = (await allCaptures()).filter((r) => r.accountId === accountId && isActive(r.state) && r.operationId);
  for (const r of recs) {
    try {
      await pollCapture(r.captureId);
    } catch (e) {
      if (e instanceof AppError && e.code === "auth_required") return;
    }
  }
  await syncAlarm();
}

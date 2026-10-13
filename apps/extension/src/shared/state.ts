// Capture/operation state machine. Pure module (unit-tested); no chrome.* access.

export const CAPTURE_STATES = [
  "idle",
  "extracting",
  "validating", // editable preview before submission
  "queued",
  "analyzing",
  "partial-result",
  "completed",
  "failed",
  "timed-out",
  "cancellation-requested",
  "cancelled",
] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

const REMOTE_ACTIVE: CaptureState[] = ["queued", "analyzing", "cancellation-requested"];
const REMOTE_TERMINAL: CaptureState[] = ["partial-result", "completed", "failed", "timed-out", "cancelled"];
const FROM_ACTIVE: CaptureState[] = [...REMOTE_ACTIVE, ...REMOTE_TERMINAL];

/** Allowed transitions. Self-transitions (stage updates) are allowed for active states. */
export const TRANSITIONS: Readonly<Record<CaptureState, readonly CaptureState[]>> = {
  idle: ["extracting", "validating"],
  extracting: ["validating", "failed", "idle"],
  validating: ["extracting", "queued", "completed", "failed", "idle"],
  queued: FROM_ACTIVE,
  analyzing: ["analyzing", "partial-result", "completed", "failed", "timed-out", "cancellation-requested", "cancelled"],
  // The backend may still finish (or fail) after cancellation was requested; that is recorded honestly.
  "cancellation-requested": ["cancellation-requested", "cancelled", "completed", "partial-result", "failed", "timed-out"],
  "partial-result": ["idle"],
  completed: ["idle"],
  failed: ["queued", "idle"], // queued = server-side retry
  "timed-out": ["queued", "idle"],
  cancelled: ["idle"],
};

export function canTransition(from: CaptureState, to: CaptureState): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(s: CaptureState): boolean {
  return REMOTE_TERMINAL.includes(s);
}

export function isActive(s: CaptureState): boolean {
  return REMOTE_ACTIVE.includes(s);
}

export function isRetryable(s: CaptureState): boolean {
  return s === "failed" || s === "timed-out";
}

export type OperationState =
  | "queued"
  | "running"
  | "partially_succeeded"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancellation_requested"
  | "cancelled";

const OP_MAP: Record<OperationState, CaptureState> = {
  queued: "queued",
  running: "analyzing",
  partially_succeeded: "partial-result",
  succeeded: "completed",
  failed: "failed",
  timed_out: "timed-out",
  cancellation_requested: "cancellation-requested",
  cancelled: "cancelled",
};

export function mapOperationState(s: string): CaptureState | null {
  return Object.prototype.hasOwnProperty.call(OP_MAP, s) ? OP_MAP[s as OperationState] : null;
}

/** Validated subset of GET /api/v1/operations/{id}. */
export interface OperationView {
  id: string;
  state: OperationState;
  stage: string | null;
  attempt: number;
  maxAttempts: number;
  terminal: boolean;
  error: { code: string; message: string } | null;
  result: { jobId: string | null; analysisId: string | null; status: string | null } | null;
}

const s = (v: unknown, max = 500): string | null => (typeof v === "string" ? v.slice(0, max) : null);

export function toOperationView(json: unknown): OperationView | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const id = s(o.id, 64);
  const state = s(o.state, 40);
  if (!id || !state || mapOperationState(state) === null) return null;
  let error: OperationView["error"] = null;
  if (o.error && typeof o.error === "object") {
    const e = o.error as Record<string, unknown>;
    error = { code: s(e.code, 80) ?? "error", message: s(e.message, 1000) ?? "The operation failed." };
  }
  let result: OperationView["result"] = null;
  if (o.result && typeof o.result === "object") {
    const r = o.result as Record<string, unknown>;
    result = { jobId: s(r.job_id, 64), analysisId: s(r.analysis_id, 64), status: s(r.status, 40) };
  }
  return {
    id,
    state: state as OperationState,
    stage: s(o.stage, 80),
    attempt: typeof o.attempt === "number" ? o.attempt : 0,
    maxAttempts: typeof o.max_attempts === "number" ? o.max_attempts : 0,
    terminal: o.terminal === true,
    error,
    result,
  };
}

export interface CaptureError {
  code: string;
  message: string;
  requestId: string | null;
}

/** A capture tracked by the service worker (persisted in chrome.storage.session, mirrored in .local). */
export interface CaptureRecord {
  captureId: string;
  operationId: string | null;
  jobId: string;
  analysisId: string | null;
  /** null once the tab is closed or after a browser restart (tab ids are not stable across restarts). */
  tabId: number | null;
  /** normalised page URL; "" for manual text without a page */
  url: string;
  accountId: string;
  state: CaptureState;
  stage: string | null;
  attempt: number;
  maxAttempts: number;
  error: CaptureError | null;
  /** network reachability as seen by the last poll; NOT a backend state */
  connection: "ok" | "lost";
  title: string | null;
  startedAt: number;
  updatedAt: number;
  /** issue time of the newest poll response that was applied (stale responses are ignored) */
  appliedAt: number;
  /** increments on every applied change */
  seq: number;
}

/**
 * Apply an operation snapshot obtained by a poll issued at `issuedAt`.
 * Returns the updated record, or null when the response is stale, belongs to another operation,
 * or would be an illegal transition (e.g. a late "running" after "succeeded").
 */
export function applyOperation(rec: CaptureRecord, op: OperationView, issuedAt: number, now: number): CaptureRecord | null {
  if (rec.operationId === null || op.id !== rec.operationId) return null;
  if (issuedAt < rec.appliedAt) return null;
  const next = mapOperationState(op.state);
  if (next === null) return null;
  if (!canTransition(rec.state, next)) return null;
  return {
    ...rec,
    state: next,
    stage: op.stage,
    attempt: op.attempt,
    maxAttempts: op.maxAttempts,
    error:
      next === "failed" || next === "timed-out"
        ? { code: op.error?.code ?? next, message: op.error?.message ?? "The analysis did not finish.", requestId: null }
        : null,
    analysisId: op.result?.analysisId ?? rec.analysisId,
    jobId: op.result?.jobId ?? rec.jobId,
    connection: "ok",
    appliedAt: issuedAt,
    updatedAt: now,
    seq: rec.seq + 1,
  };
}

/** UI polling delays: 1s, 2s, 4s, then every 5s. */
export function pollDelayMs(attempt: number): number {
  const steps = [1000, 2000, 4000, 5000];
  return steps[Math.min(Math.max(attempt, 0), steps.length - 1)] ?? 5000;
}

/** Record matching rule for the popup/side panel: same tab AND same normalised URL AND same account. */
export function recordMatches(rec: CaptureRecord, tabId: number | null, normalizedUrl: string | null, accountId: string | null): boolean {
  return (
    tabId !== null &&
    normalizedUrl !== null &&
    accountId !== null &&
    rec.tabId === tabId &&
    rec.url === normalizedUrl &&
    rec.accountId === accountId
  );
}

export function badgeFor(state: CaptureState): { text: string; color: string } {
  if (isActive(state)) return { text: "…", color: "#5b5f66" };
  if (state === "completed" || state === "partial-result") return { text: "✓", color: "#2f6f4f" };
  if (state === "failed" || state === "timed-out" || state === "cancelled") return { text: "!", color: "#a33a2b" };
  return { text: "", color: "#5b5f66" };
}

const STATE_LABEL: Record<CaptureState, string> = {
  idle: "Ready",
  extracting: "Reading the page",
  validating: "Review before analysing",
  queued: "Queued on the server",
  analyzing: "Analysing",
  "partial-result": "Partial result",
  completed: "Analysis complete",
  failed: "Analysis failed",
  "timed-out": "Analysis timed out",
  "cancellation-requested": "Cancellation requested",
  cancelled: "Cancelled",
};

export function stateLabel(s: CaptureState): string {
  return STATE_LABEL[s];
}

/** Human form of a backend stage identifier, e.g. "retry_scheduled" -> "Retry scheduled". */
export function stageLabel(stage: string | null): string | null {
  if (!stage) return null;
  const t = stage.replace(/[_\-.]+/g, " ").trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

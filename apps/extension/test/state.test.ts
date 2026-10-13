import { describe, expect, it } from "vitest";
import {
  CAPTURE_STATES,
  TRANSITIONS,
  applyOperation,
  badgeFor,
  canTransition,
  isTerminal,
  mapOperationState,
  pollDelayMs,
  recordMatches,
  stageLabel,
  toOperationView,
  type CaptureRecord,
  type OperationView,
} from "../src/shared/state";

const rec = (over: Partial<CaptureRecord> = {}): CaptureRecord => ({
  captureId: "11111111-1111-4111-8111-111111111111",
  operationId: "op-1",
  jobId: "22222222-2222-4222-8222-222222222222",
  analysisId: null,
  tabId: 7,
  url: "https://careers.example.test/jobs/1",
  accountId: "user-a",
  state: "queued",
  stage: "queued",
  attempt: 0,
  maxAttempts: 0,
  error: null,
  connection: "ok",
  title: null,
  startedAt: 1,
  updatedAt: 1,
  appliedAt: 100,
  seq: 1,
  ...over,
});

const op = (over: Partial<OperationView> = {}): OperationView => ({
  id: "op-1",
  state: "running",
  stage: "extracting_requirements",
  attempt: 1,
  maxAttempts: 3,
  terminal: false,
  error: null,
  result: null,
  ...over,
});

describe("transition table", () => {
  it("covers every state", () => {
    for (const s of CAPTURE_STATES) expect(TRANSITIONS[s]).toBeDefined();
  });

  it("follows the capture flow", () => {
    expect(canTransition("idle", "extracting")).toBe(true);
    expect(canTransition("extracting", "validating")).toBe(true);
    expect(canTransition("validating", "queued")).toBe(true);
    expect(canTransition("validating", "completed")).toBe(true); // reused analysis
    expect(canTransition("queued", "analyzing")).toBe(true);
    expect(canTransition("analyzing", "partial-result")).toBe(true);
    expect(canTransition("analyzing", "cancellation-requested")).toBe(true);
    expect(canTransition("cancellation-requested", "completed")).toBe(true); // finished before checkpoint
    expect(canTransition("failed", "queued")).toBe(true); // retry
    expect(canTransition("timed-out", "queued")).toBe(true);
  });

  it("forbids going backwards from terminal states", () => {
    for (const t of ["completed", "partial-result", "cancelled"] as const) {
      for (const s of ["queued", "analyzing", "cancellation-requested"] as const) expect(canTransition(t, s)).toBe(false);
    }
    expect(canTransition("failed", "analyzing")).toBe(false);
    expect(canTransition("analyzing", "queued")).toBe(false);
    expect(canTransition("idle", "completed")).toBe(false);
  });

  it("maps every backend operation state", () => {
    expect(mapOperationState("running")).toBe("analyzing");
    expect(mapOperationState("partially_succeeded")).toBe("partial-result");
    expect(mapOperationState("timed_out")).toBe("timed-out");
    expect(mapOperationState("cancellation_requested")).toBe("cancellation-requested");
    expect(mapOperationState("bogus")).toBeNull();
    expect(mapOperationState("__proto__")).toBeNull();
    expect(isTerminal("partial-result")).toBe(true);
    expect(isTerminal("cancellation-requested")).toBe(false);
  });
});

describe("applyOperation", () => {
  it("applies a newer snapshot and bumps seq", () => {
    const next = applyOperation(rec(), op(), 200, 999)!;
    expect(next.state).toBe("analyzing");
    expect(next.stage).toBe("extracting_requirements");
    expect(next.seq).toBe(2);
    expect(next.appliedAt).toBe(200);
  });

  it("ignores late/stale responses issued before the last applied one", () => {
    expect(applyOperation(rec({ appliedAt: 300 }), op(), 200, 999)).toBeNull();
  });

  it("ignores responses for a different operation", () => {
    expect(applyOperation(rec(), op({ id: "op-2" }), 200, 999)).toBeNull();
  });

  it("never regresses from a terminal state (late 'running' after 'succeeded')", () => {
    expect(applyOperation(rec({ state: "completed" }), op({ state: "running" }), 500, 999)).toBeNull();
  });

  it("records result ids and errors", () => {
    const done = applyOperation(rec({ state: "analyzing" }), op({ state: "succeeded", terminal: true, result: { jobId: "j", analysisId: "a", status: "complete" } }), 200, 1)!;
    expect(done.state).toBe("completed");
    expect(done.analysisId).toBe("a");
    const failed = applyOperation(rec({ state: "analyzing" }), op({ state: "failed", error: { code: "model_unavailable", message: "Model down" } }), 200, 1)!;
    expect(failed.error).toEqual({ code: "model_unavailable", message: "Model down", requestId: null });
  });

  it("clears 'connection lost' once a response arrives", () => {
    expect(applyOperation(rec({ connection: "lost" }), op(), 200, 1)!.connection).toBe("ok");
  });
});

describe("toOperationView", () => {
  it("validates the API shape", () => {
    const v = toOperationView({ id: "x", state: "queued", stage: "queued", attempt: 0, max_attempts: 3, terminal: false, error: null, result: null });
    expect(v?.state).toBe("queued");
    expect(toOperationView({ id: "x", state: "exploded" })).toBeNull();
    expect(toOperationView("nope")).toBeNull();
  });
});

describe("recordMatches", () => {
  const r = rec();
  it("requires the same tab, URL and account", () => {
    expect(recordMatches(r, 7, r.url, "user-a")).toBe(true);
    expect(recordMatches(r, 8, r.url, "user-a")).toBe(false); // newly active tab
    expect(recordMatches(r, 7, "https://careers.example.test/jobs/2", "user-a")).toBe(false); // navigated
    expect(recordMatches(r, 7, r.url, "user-b")).toBe(false); // account switch
    expect(recordMatches({ ...r, tabId: null }, 7, r.url, "user-a")).toBe(false); // orphaned after restart
    expect(recordMatches(r, null, r.url, "user-a")).toBe(false);
  });
});

describe("helpers", () => {
  it("polls with 1-2-4-5s backoff", () => {
    expect([0, 1, 2, 3, 4, 10].map(pollDelayMs)).toEqual([1000, 2000, 4000, 5000, 5000, 5000]);
  });
  it("labels backend stages without inventing progress", () => {
    expect(stageLabel("retry_scheduled")).toBe("Retry scheduled");
    expect(stageLabel(null)).toBeNull();
  });
  it("chooses badge text", () => {
    expect(badgeFor("analyzing").text).toBe("…");
    expect(badgeFor("completed").text).toBe("✓");
    expect(badgeFor("failed").text).toBe("!");
    expect(badgeFor("idle").text).toBe("");
  });
});

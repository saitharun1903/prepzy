// @vitest-environment happy-dom
// Smoke test of the popup UI against a mocked chrome.* surface and a scripted service worker.
// This exercises rendering and the message flow; it is NOT a browser runtime test.
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { CaptureRecord } from "../src/shared/state";

const TAB_URL = "https://careers.example.test/jobs/42";
// A page that is not recognisably a single job: the popup waits for the user to click Analyze.
const NON_JOB_URL = "https://careers.example.test/about-us";
let tabUrl = TAB_URL;
const JOB_ID = "3f2b7c1e-8a4d-4f6b-9c2e-1d5a7b9e0f12";
const sent: { type: string; [k: string]: unknown }[] = [];
let signedIn = false;
let pollState: "running" | "succeeded" = "running";

const record = (state: CaptureRecord["state"], seq: number): CaptureRecord => ({
  captureId: (sent.find((m) => m.type === "capture.submit")?.captureId as string) ?? "x",
  operationId: "op-1",
  jobId: JOB_ID,
  analysisId: state === "completed" ? "an-1" : null,
  tabId: 5,
  url: TAB_URL,
  accountId: "u1",
  state,
  stage: state === "queued" ? "queued" : state === "analyzing" ? "extracting_requirements" : "succeeded",
  attempt: 1,
  maxAttempts: 3,
  error: null,
  connection: "ok",
  title: "Backend Engineer",
  startedAt: Date.now(),
  updatedAt: Date.now(),
  appliedAt: seq,
  seq,
});

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
  company: "Ostrava Freight",
  location: null,
  text: "Requirements: 4+ years building backend services. ".repeat(10),
  textLength: 510,
  truncated: false,
  selection: null,
  attempts: 1,
};

function reply(m: { type: string; [k: string]: unknown }): unknown {
  sent.push(m);
  switch (m.type) {
    case "state.get":
      return { ok: true, data: { signedIn, email: signedIn ? "me@example.test" : null, record: null, recent: [], extraction: null, webBase: "http://localhost:3000" } };
    case "page.lookup":
      return { ok: true, data: { job: null } };
    case "page.extract":
      return { ok: true, data: extraction };
    case "capture.submit":
      return { ok: true, data: record("queued", 1) };
    case "capture.poll":
      return { ok: true, data: pollState === "running" ? record("analyzing", 2) : record("completed", 3) };
    case "job.get":
      return {
        ok: true,
        data: {
          job: { id: JOB_ID, title: "Backend Engineer", company: "Ostrava Freight", sourceUrl: TAB_URL, saved: false },
          analysis: {
            id: "an-1",
            status: "complete",
            model: "test-model",
            promptVersion: "p1",
            schemaVersion: "s1",
            createdAt: null,
            isLatest: true,
            stale: false,
            fields: Object.fromEntries(
              ["title", "company", "location", "work_mode", "employment_type", "seniority", "experience", "education", "salary", "deadline", "posted"].map((k) => [
                k,
                { value: k === "title" ? "Backend Engineer" : k === "company" ? "Ostrava Freight" : null, source: "job_text", note: null, conflict: null },
              ]),
            ),
            requirements: [
              { key: "r1", text: "4+ years building backend services", importance: "required", alternatives: null, concepts: [], negated: false, notes: [] },
              { key: "r2", text: "Java or Kotlin", importance: "required", alternatives: ["Java", "Kotlin"], concepts: ["Java", "Kotlin"], negated: false, notes: [] },
              { key: "r3", text: "Kafka", importance: "preferred", alternatives: null, concepts: [], negated: false, notes: [] },
            ],
            issues: [],
          },
          historyCount: 1,
          activeOperations: 0,
        },
      };
    case "job.applications":
      return { ok: true, data: { current: null } };
    case "job.match":
      return {
        ok: true,
        data: {
          match: {
            reportId: "rep-1", scoreStatus: "available", withheldReason: null,
            required: { coverage: 50, total: 2, met: 1 }, preferred: { coverage: 0, total: 1, met: 0 },
            status: { r1: "unassessable", r2: "supported", r3: "not_evidenced" },
            missing: ["Kafka"], hasResume: true, stale: false,
          },
        },
      };
    default:
      return { ok: false, error: { code: "unexpected", message: m.type, requestId: null, retryable: false } };
  }
}

const registered: Record<string, ((...a: unknown[]) => void)[]> = {};
const listeners = (name: string) => ({ addListener: (fn: (...a: unknown[]) => void) => (registered[name] ??= []).push(fn) });
const created: unknown[] = [];
const sessionStore: Record<string, unknown> = {};

beforeAll(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: async (m: { type: string }) => reply(m) },
    tabs: { query: vi.fn(async () => [{ id: 5, windowId: 1, url: tabUrl, title: "Backend Engineer – Ostrava Freight" }]), create: (o: unknown) => created.push(o), onActivated: listeners("tabs.onActivated"), onUpdated: listeners("tabs.onUpdated") },
    storage: {
      session: {
        get: vi.fn(async (k: string) => ({ [k]: sessionStore[k] })),
        set: vi.fn(async (o: Record<string, unknown>) => Object.assign(sessionStore, o)),
        remove: vi.fn(async (k: string) => delete sessionStore[k]),
      },
      onChanged: listeners("storage.onChanged"),
    },
    sidePanel: { open: vi.fn() },
  };
  document.documentElement.dataset.context = "popup";
  document.body.innerHTML = `<div id="live" aria-live="polite"></div><div id="app"></div>`;
  (window as unknown as { close: () => void }).close = vi.fn();
});

const flush = async (ms = 0) => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, ms));
};
const app = () => document.getElementById("app")!;
const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();

describe("popup UI flow", () => {
  it("shows the connect screen when signed out", async () => {
    await import("../src/ui/app");
    await flush();
    expect(app().textContent).toContain("Connect Prepzy");
    click("btn-connect");
    expect(created[0]).toEqual({ url: "http://localhost:3000/extension/connect" });
  });

  it("goes main -> preview -> progress -> result", async () => {
    signedIn = true;
    tabUrl = NON_JOB_URL;
    // simulate the tab being re-activated to reload the context
    for (const fn of registered["tabs.onActivated"] ?? []) fn();
    await flush();
    expect(app().textContent).toContain("Analyze this job");
    expect(app().textContent).toContain("What you'll get");
    expect(app().textContent).toContain("careers.example.test");

    click("btn-review");
    await flush();
    expect(app().textContent).toContain("Review before analysing");
    expect((document.getElementById("f-title") as HTMLInputElement).value).toBe("Backend Engineer");
    expect((document.getElementById("f-company") as HTMLInputElement).value).toBe("Ostrava Freight");
    expect(app().textContent).toContain("Not stated"); // location unknown
    expect(app().textContent).toContain("General page text");

    vi.useFakeTimers({ shouldAdvanceTime: true });
    click("btn-submit");
    await flush();
    const submitted = sent.find((m) => m.type === "capture.submit")!;
    expect(submitted.source).toBe("page");
    expect(submitted.tabId).toBe(5);
    expect(app().textContent).toContain("Queued on the server");

    await vi.advanceTimersByTimeAsync(1100);
    await flush();
    expect(app().textContent).toContain("Server stage: Extracting requirements");

    pollState = "succeeded";
    await vi.advanceTimersByTimeAsync(2100);
    await flush();
    vi.useRealTimers();
    await flush(5);
    const text = app().textContent ?? "";
    await flush();
    const fit = app().textContent ?? "";
    expect(fit).toContain("Backend Engineer");
    expect(fit).toContain("Here's my read.");
    expect(fit).toContain("Missing from your resume");
    expect(fit).toContain("Kafka");
    expect(fit).toContain("You have");
    expect(fit).toContain("Java or Kotlin");
    expect(fit).toContain("Check yourself");
    expect(fit).toContain("on your resume");
    expect(app().querySelector("svg.coach")).not.toBeNull();
    expect(fit).toContain("Model test-model");
    expect(fit).toContain("Your preparation plan");
    expect(fit).toContain("Likely interview topics");
    expect(fit).toContain("Real interview experiences");
    expect(app().querySelectorAll(".research-link").length).toBe(7);
    expect(fit).not.toContain("Not a hiring prediction.Not"); // sanity: rendered once
    expect(document.getElementById("btn-applied")?.getAttribute("aria-pressed")).toBe("false");
    // no HTML from data is ever interpreted
    expect(app().querySelectorAll("script").length).toBe(0);
  });

  it("opening the popup on a job page starts the analysis without another click", async () => {
    vi.useRealTimers();
    pollState = "running";
    tabUrl = TAB_URL;
    const before = sent.filter((m) => m.type === "capture.submit").length;
    for (const fn of registered["tabs.onActivated"] ?? []) fn();
    await flush(5);
    expect(sent.filter((m) => m.type === "capture.submit").length).toBe(before + 1);
    expect(app().textContent).not.toContain("Review before analysing");
    expect(app().textContent).toContain("Server stage");
  });
});

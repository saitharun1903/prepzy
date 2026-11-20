// Popup + side panel UI (same app; layout adapts to the container).
// The UI never talks to the API: every action is a typed message to the service worker.

import { CONNECT_PAGE, WEB_BASE } from "../config";
import { MIN_TEXT, verdictFor, type ExtractResult } from "../shared/extract";
import {
  type ApplicationView,
  type JobView,
  type LookupView,
  type MatchView,
} from "../shared/jobview";
import { avatar, buildChecklist, coach, type Bucket, type ChecklistItem } from "./coach";
import type { ErrorInfo, Reply, ReplyMap, StateData, TextSource, UiRequest } from "../shared/messages";
import { isActive, isRetryable, isTerminal, pollDelayMs, stageLabel, stateLabel, type CaptureRecord } from "../shared/state";
import { classifyUrl, dashboardJobUrl, hostOf, looksLikeJobPage, normalizeUrl, type PageAccess } from "../shared/url";
import { interviewResearchLinks } from "../shared/research";
import { clear, h } from "./dom";

const IS_PANEL = document.documentElement.dataset.context === "sidepanel";
const root = document.getElementById("app")!;
const live = document.getElementById("live")!;

// ------------------------------------------------------------------ messaging

type Req<T extends UiRequest["type"]> = Extract<UiRequest, { type: T }>;

async function send<T extends UiRequest["type"]>(req: Req<T>): Promise<ReplyMap[T]> {
  let res: Reply<ReplyMap[T]> | undefined;
  try {
    res = (await chrome.runtime.sendMessage(req)) as Reply<ReplyMap[T]> | undefined;
  } catch {
    res = undefined;
  }
  if (!res) throw { code: "no_response", message: "The extension did not respond. Try again.", requestId: null, retryable: true } satisfies ErrorInfo;
  if (!res.ok) throw res.error;
  return res.data;
}

function asError(e: unknown): ErrorInfo {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as ErrorInfo;
  return { code: "internal_error", message: "Something went wrong. Try again.", requestId: null, retryable: true };
}

// ------------------------------------------------------------------ view state

interface Draft {
  url: string;
  captureId: string;
  title: string;
  company: string;
  source: TextSource;
  manualText: string;
  save: boolean;
}

type Screen = "loading" | "signed-out" | "main" | "preview" | "progress" | "result";

interface View {
  seq: number; // bumps whenever the tab context changes; late replies for an older seq are dropped
  tabId: number | null;
  windowId: number | null;
  url: string | null;
  norm: string | null;
  tabTitle: string | null;
  access: PageAccess;
  state: StateData | null;
  screen: Screen;
  lookup: LookupView | null | undefined;
  extraction: ExtractResult | null;
  draft: Draft | null;
  record: CaptureRecord | null;
  resultJobId: string | null;
  job: JobView | null;
  match: MatchView | null | undefined;
  application: ApplicationView | null | undefined;
  busy: string | null;
  error: ErrorInfo | null;
  notice: string | null;
  connectionLost: boolean;
  resultTab: ResultTab;
}

type ResultTab = "match" | "prepare" | "interviews" | "track";

const v: View = {
  seq: 0,
  tabId: null,
  windowId: null,
  url: null,
  norm: null,
  tabTitle: null,
  access: { kind: "unknown", reason: "" },
  state: null,
  screen: "loading",
  lookup: undefined,
  extraction: null,
  draft: null,
  record: null,
  resultJobId: null,
  job: null,
  match: undefined,
  application: undefined,
  busy: null,
  resultTab: "match",
  error: null,
  notice: null,
  connectionLost: false,
};

let pollTimer: ReturnType<typeof setTimeout> | null = null;
let pollCount = 0;
let lastAnnounced = "";

function announce(text: string): void {
  if (!text || text === lastAnnounced) return;
  lastAnnounced = text;
  live.textContent = text;
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = null;
}

// ------------------------------------------------------------------ loading the current tab context

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

async function load(): Promise<void> {
  const seq = ++v.seq;
  stopPolling();
  pollCount = 0;
  const tab = await activeTab();
  if (seq !== v.seq) return;
  v.tabId = tab?.id ?? null;
  v.windowId = tab?.windowId ?? null;
  v.url = tab?.url ?? null;
  v.norm = normalizeUrl(v.url);
  v.tabTitle = tab?.title ?? null;
  v.access = classifyUrl(v.url);
  v.error = null;
  v.notice = null;
  v.lookup = undefined;
  v.extraction = null;
  v.draft = null;
  v.record = null;
  v.job = null;
  v.match = undefined;
  v.application = undefined;
  v.resultJobId = null;
  v.resultTab = "match";
  v.connectionLost = false;
  try {
    const st = await send({ v: 1, type: "state.get", tabId: v.tabId, url: v.url });
    if (seq !== v.seq) return;
    v.state = st;
  } catch (e) {
    if (seq !== v.seq) return;
    v.error = asError(e);
    v.screen = "main";
    render();
    return;
  }
  if (!v.state.signedIn) {
    v.screen = "signed-out";
    render();
    return;
  }
  v.extraction = v.state.extraction?.result ?? null;
  const rec = v.state.record;
  if (rec && rec.tabId === v.tabId && rec.url === v.norm) {
    showRecord(rec);
    return;
  }
  // Restore an unsent preview for this tab + URL (the popup closes when the user clicks the page).
  if (v.tabId !== null && v.norm) {
    const key = `draft:${v.tabId}`;
    const stored = (await chrome.storage.session.get(key).catch(() => ({}) as Record<string, unknown>))[key] as Draft | undefined;
    if (seq !== v.seq) return;
    if (stored && stored.url === v.norm && (v.extraction || stored.source === "manual")) {
      v.draft = stored;
      v.screen = "preview";
      render();
      return;
    }
  }
  v.screen = "main";
  render();
  void loadLookup(seq);
}

async function loadLookup(seq: number): Promise<void> {
  if (!v.url || v.access.kind !== "ok") {
    v.lookup = null;
    return;
  }
  try {
    const r = await send({ v: 1, type: "page.lookup", url: v.url });
    if (seq !== v.seq) return;
    v.lookup = r.job;
  } catch (e) {
    if (seq !== v.seq) return;
    v.lookup = null;
    if (handleAuthError(e)) return;
  }
  if (v.screen !== "main") return;
  // One click: opening Prepzy on a job page shows the saved result, or starts the analysis right away.
  if (v.lookup?.latestAnalysisId) {
    viewExisting(v.lookup.id);
    return;
  }
  if (!v.lookup && !v.busy && looksLikeJobPage(v.url)) {
    void readPage(true);
    return;
  }
  render();
}

function handleAuthError(e: unknown): boolean {
  const err = asError(e);
  if (err.code === "auth_required") {
    stopPolling();
    v.state = v.state ? { ...v.state, signedIn: false, email: null } : null;
    v.screen = "signed-out";
    v.notice = err.message;
    render();
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ records & polling

function showRecord(rec: CaptureRecord): void {
  v.record = rec;
  v.connectionLost = rec.connection === "lost";
  if (isTerminal(rec.state)) {
    stopPolling();
    v.screen = "result";
    v.resultJobId = rec.jobId;
    render();
    if (rec.state === "completed" || rec.state === "partial-result") void loadJob(rec.jobId, v.seq);
  } else {
    v.screen = "progress";
    render();
    schedulePoll();
  }
  announce(`${stateLabel(rec.state)}${rec.stage ? `. ${stageLabel(rec.stage)}` : ""}`);
}

function schedulePoll(): void {
  stopPolling();
  const rec = v.record;
  if (!rec || !isActive(rec.state)) return;
  const seq = v.seq;
  const captureId = rec.captureId;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    pollCount++;
    try {
      const next = await send({ v: 1, type: "capture.poll", captureId });
      if (seq !== v.seq || v.record?.captureId !== captureId) return; // stale: tab/page changed
      if (next.seq < (v.record?.seq ?? 0)) return; // older than what we show
      v.error = null;
      showRecord(next);
    } catch (e) {
      if (seq !== v.seq || handleAuthError(e)) return;
      v.connectionLost = true;
      v.error = asError(e);
      render();
      schedulePoll();
    }
  }, pollDelayMs(pollCount));
}

async function loadJob(jobId: string, seq: number): Promise<void> {
  try {
    const [job, apps] = await Promise.all([
      send({ v: 1, type: "job.get", jobId }),
      send({ v: 1, type: "job.applications", jobId }).catch(() => ({ current: null })),
    ]);
    if (seq !== v.seq || v.resultJobId !== jobId) return;
    v.job = job;
    v.application = apps.current;
  } catch (e) {
    if (seq !== v.seq || handleAuthError(e)) return;
    v.error = asError(e);
  }
  render();
  if (v.job?.analysis) {
    // Fit summary: compare with the default resume (separate request so the analysis shows first).
    try {
      const m = await send({ v: 1, type: "job.match", jobId });
      if (seq !== v.seq || v.resultJobId !== jobId) return;
      v.match = m.match;
    } catch (e) {
      if (seq !== v.seq || handleAuthError(e)) return;
      v.match = null;
    }
    render();
  }
}

// ------------------------------------------------------------------ actions

async function run(label: string, fn: () => Promise<void>): Promise<void> {
  if (v.busy) return;
  v.busy = label;
  v.error = null;
  v.notice = null;
  render();
  try {
    await fn();
  } catch (e) {
    if (!handleAuthError(e)) v.error = asError(e);
  } finally {
    v.busy = null;
    render();
  }
}

function newDraft(ext: ExtractResult | null, source: TextSource): Draft {
  return {
    url: v.norm ?? "",
    captureId: crypto.randomUUID(),
    title: ext?.title ?? "",
    company: ext?.company ?? "",
    source,
    manualText: "",
    save: false,
  };
}

function persistDraft(): void {
  if (v.tabId === null || !v.draft) return;
  void chrome.storage.session.set({ [`draft:${v.tabId}`]: v.draft }).catch(() => undefined);
}

function discardDraft(): void {
  if (v.tabId !== null) void chrome.storage.session.remove(`draft:${v.tabId}`).catch(() => undefined);
  v.draft = null;
}

/** Read the page. With `quick`, a clean single-job read is sent straight for analysis (one click);
 * anything that needs attention (multiple jobs, too little text, a selection) opens the review screen. */
const readPage = (quick = false) =>
  run(quick ? "Reading the job" : "Reading the page", async () => {
    if (v.tabId === null) throw { code: "no_tab", message: "No active tab.", requestId: null, retryable: false };
    const seq = v.seq;
    announce("Reading the page");
    const ext = await send({ v: 1, type: "page.extract", tabId: v.tabId });
    if (seq !== v.seq) return;
    v.extraction = ext;
    const verdict = verdictFor(ext);
    const prev = v.draft;
    const source: TextSource = ext.selection ? "selection" : verdict.kind === "ok" ? "page" : "manual";
    v.draft = prev && prev.url === v.norm ? { ...prev, source: prev.source === "manual" && prev.manualText ? "manual" : source } : newDraft(ext, source);
    if (!v.draft.title && ext.title) v.draft.title = ext.title;
    if (!v.draft.company && ext.company) v.draft.company = ext.company;
    persistDraft();
    if (quick && verdict.kind === "ok" && !ext.selection && v.draft.source === "page") {
      await sendDraft(v.draft, seq);
      return;
    }
    v.screen = "preview";
    announce(verdict.kind === "multiple" ? `This page lists ${verdict.count} jobs` : "Preview ready");
  });

function startManual(): void {
  v.draft = v.draft ?? newDraft(v.extraction, "manual");
  v.draft.source = "manual";
  persistDraft();
  v.screen = "preview";
  v.error = null;
  render();
  document.getElementById("manual-text")?.focus();
}

async function sendDraft(d: Draft, seq: number): Promise<void> {
  const rec = await send({
      v: 1,
      type: "capture.submit",
      captureId: d.captureId,
      tabId: v.tabId,
      source: d.source,
      manualText: d.source === "manual" ? d.manualText : null,
      title: d.title.trim() ? d.title.trim().slice(0, 300) : null,
      company: d.company.trim() ? d.company.trim().slice(0, 300) : null,
      save: d.save,
    });
  if (seq !== v.seq) return;
  v.draft = null;
  showRecord(rec);
}

const submit = () =>
  run("Sending to Prepzy", async () => {
    const d = v.draft;
    if (!d) return;
    await sendDraft(d, v.seq);
  });

const cancelCapture = () =>
  run("Requesting cancellation", async () => {
    if (!v.record) return;
    const rec = await send({ v: 1, type: "capture.cancel", captureId: v.record.captureId });
    showRecord(rec);
  });

const retryCapture = () =>
  run("Retrying", async () => {
    if (!v.record) return;
    const rec = await send({ v: 1, type: "capture.retry", captureId: v.record.captureId });
    pollCount = 0;
    showRecord(rec);
  });

const checkAgain = () =>
  run("Checking", async () => {
    if (!v.record) return;
    const rec = await send({ v: 1, type: "capture.poll", captureId: v.record.captureId });
    pollCount = 0;
    showRecord(rec);
  });

const startOver = () =>
  run("Resetting", async () => {
    if (v.record) await send({ v: 1, type: "capture.dismiss", captureId: v.record.captureId });
    discardDraft();
    await load();
  });

function openTab(url: string | null): void {
  if (!url) return;
  void chrome.tabs.create({ url });
  if (!IS_PANEL) window.close();
}

const dashboardUrl = (jobId: string | null | undefined) => (jobId ? dashboardJobUrl(v.state?.webBase ?? WEB_BASE, jobId) : null);

const toggleSave = () =>
  run("Updating saved jobs", async () => {
    const job = v.job;
    if (!job) return;
    const r = await send({ v: 1, type: "job.save", jobId: job.job.id, saved: !job.job.saved });
    v.job = { ...job, job: { ...job.job, saved: r.saved } };
    v.notice = r.saved ? "Saved to your jobs." : "Removed from saved jobs. Analyses, notes and applications are kept.";
    announce(v.notice);
  });

const setStatus = (status: "planned" | "applied") =>
  run("Updating application", async () => {
    if (!v.job) return;
    const r = await send({ v: 1, type: "job.application.set", jobId: v.job.job.id, status });
    v.application = r.current;
    v.notice = `Application status: ${r.current.status}.`;
    announce(v.notice);
  });

const addNote = (body: string, done: () => void) =>
  run("Adding note", async () => {
    if (!v.job) return;
    await send({ v: 1, type: "job.note", jobId: v.job.job.id, body });
    v.notice = "Note added.";
    announce(v.notice);
    done();
  });

const addReminder = (title: string, dueDate: string, remindTime: string) =>
  run("Adding reminder", async () => {
    if (!v.job) return;
    const r = await send({ v: 1, type: "job.reminder", jobId: v.job.job.id, title, dueDate, remindTime });
    v.notice = r.note ? `Reminder added. ${r.note}` : "Reminder added.";
    announce(v.notice);
  });

const viewExisting = (jobId: string) => {
  v.resultJobId = jobId;
  v.record = null;
  v.job = null;
  v.screen = "result";
  render();
  void loadJob(jobId, v.seq);
};

const signOut = () =>
  run("Signing out", async () => {
    await send({ v: 1, type: "auth.logout" });
    await load();
  });

async function openSidePanel(): Promise<void> {
  try {
    if (v.windowId !== null) await chrome.sidePanel.open({ windowId: v.windowId });
    window.close();
  } catch {
    v.error = { code: "side_panel", message: "The side panel could not be opened in this browser.", requestId: null, retryable: false };
    render();
  }
}

// ------------------------------------------------------------------ rendering

function button(label: string, onClick: () => void, opts: { kind?: "primary" | "secondary" | "quiet" | "danger"; disabled?: boolean; id?: string; pressed?: boolean } = {}) {
  return h("button", {
    type: "button",
    class: `btn btn-${opts.kind ?? "secondary"}`,
    id: opts.id,
    text: label,
    disabled: opts.disabled ?? !!v.busy,
    attrs: opts.pressed === undefined ? undefined : { "aria-pressed": opts.pressed ? "true" : "false" },
    on: { click: () => onClick() },
  });
}

const EXT_VERSION: string = (() => { try { return chrome.runtime.getManifest?.().version ?? ""; } catch { return ""; } })();

function header(): HTMLElement {
  const signedIn = !!v.state?.signedIn;
  const email = v.state?.email ?? "";
  return h(
    "header",
    { class: "top" },
    h("div", { class: "brand" }, h("span", { class: "mark", attrs: { "aria-hidden": "true" }, text: "P" }), h("span", { class: "wordmark", text: "Prepzy" }), EXT_VERSION ? h("span", { class: "ver", text: `v${EXT_VERSION}` }) : null),
    signedIn
      ? h(
          "div",
          { class: "account" },
          !IS_PANEL ? button("Side panel", () => void openSidePanel(), { kind: "quiet", id: "btn-panel" }) : null,
          button("Sign out", () => void signOut(), { kind: "quiet", id: "btn-signout" }),
          h("span", { class: "me", text: (email.charAt(0) || "?").toUpperCase(), attrs: { title: `Signed in as ${email}`, "aria-label": `Signed in as ${email}`, role: "img" } }),
        )
      : null,
  );
}

function banners(): (HTMLElement | null)[] {
  return [
    v.error
      ? h(
          "div",
          { class: "banner banner-error", attrs: { role: "alert" } },
          h("p", { text: v.error.message }),
        )
      : null,
    v.notice ? h("div", { class: "banner banner-note", attrs: { role: "status" } }, h("p", { text: v.notice })) : null,
    v.busy ? h("p", { class: "busy", attrs: { role: "status" }, text: `${v.busy}…` }) : null,
  ];
}

function heading(text: string): HTMLElement {
  return h("h1", { class: "title", id: "screen-title", text, attrs: { tabindex: "-1" } });
}

function pageCard(): HTMLElement {
  return h(
    "section",
    { class: "card page", attrs: { "aria-label": "Current page" } },
    h("p", { class: "eyebrow", text: hostOf(v.url) || "This tab" }),
    h("p", { class: "page-title", text: v.tabTitle || v.url || "Untitled page" }),
  );
}

function onboardStep(n: number, title: string, detail: string): HTMLElement {
  return h("li", { class: "onboard-step" },
    h("span", { class: "onboard-n", attrs: { "aria-hidden": "true" }, text: String(n) }),
    h("div", {}, h("p", { class: "onboard-t", text: title }), h("p", { class: "onboard-d", text: detail })));
}

function renderSignedOut(): HTMLElement[] {
  const web = v.state?.webBase ?? WEB_BASE;
  return [
    h("section", { class: "welcome" },
      h("div", { class: "welcome-avatar" }, avatar("wave", 64)),
      h("h1", { class: "welcome-title", id: "screen-title", text: "Welcome to Prepzy", attrs: { tabindex: "-1" } }),
      h("p", { class: "welcome-sub", text: "See how well you match any job in one click, then get a plan to close the gaps." }),
    ),
    h("ol", { class: "onboard", attrs: { "aria-label": "Get started in 3 steps" } },
      onboardStep(1, "Sign in on the Prepzy website", "No account yet? Create one free in a minute."),
      onboardStep(2, "Click \u201cConnect extension\u201d", "This links the extension to your account. Your password is never shared with it."),
      onboardStep(3, "Open any job and click the Prepzy icon", "Your match, plan and interview prep appear in seconds."),
    ),
    button("Connect Prepzy", () => openTab(CONNECT_PAGE), { kind: "primary", id: "btn-connect", disabled: false }),
    h("p", { class: "welcome-alt" }, "New here? ",
      h("button", { type: "button", class: "link", id: "btn-register", text: "Create a free account", on: { click: () => openTab(`${web}/register`) } })),
  ];
}

function recentList(): HTMLElement | null {
  const recent = (v.state?.recent ?? []).filter((r) => r.jobId);
  if (!recent.length) return null;
  return h(
    "section",
    { class: "recent", attrs: { "aria-labelledby": "recent-h" } },
    h("h2", { class: "section-h", id: "recent-h", text: "Recent captures (other pages)" }),
    h(
      "ul",
      { class: "plain" },
      recent.map((r) =>
        h(
          "li",
          { class: "recent-row" },
          h("span", { class: "recent-name", text: r.title || hostOf(r.url) || "Pasted text" }),
          h("span", { class: `pill pill-${pillKind(r)}`, text: stateLabel(r.state) }),
          h("button", {
            type: "button",
            class: "link",
            text: "Dashboard",
            attrs: { "aria-label": `Open ${r.title || hostOf(r.url) || "capture"} in the dashboard` },
            on: { click: () => openTab(dashboardUrl(r.jobId)) },
          }),
        ),
      ),
    ),
  );
}

function pillKind(r: CaptureRecord): string {
  if (isActive(r.state)) return "active";
  if (r.state === "completed" || r.state === "partial-result") return "ok";
  return "warn";
}

/** "Java Software Engineer | Droisys | LinkedIn" -> "Java Software Engineer · Droisys" */
function cleanTabTitle(t: string | null): string | null {
  if (!t) return null;
  const parts = t.replace(/^\(\d+\)\s*/, "").split(/\s+[|–—-]\s+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 2 && /^(linkedin|indeed|naukri|glassdoor|wellfound|greenhouse|lever|monster|foundit)/i.test(parts[parts.length - 1]!)) parts.pop();
  return parts.slice(0, 2).join(" · ") || t;
}

function benefit(icon: string, title: string, text: string): HTMLElement {
  return h("li", { class: "benefit" }, h("span", { class: "benefit-icon", attrs: { "aria-hidden": "true" }, text: icon }), h("div", null, h("p", { class: "benefit-t", text: title }), h("p", { class: "benefit-d", text })));
}

function renderMain(): HTMLElement[] {
  const out: HTMLElement[] = [];
  const a = v.access;
  const site = hostOf(v.url)?.replace(/^www\./, "") || "This tab";
  out.push(
    h(
      "section",
      { class: "card page", attrs: { "aria-label": "Current page" } },
      h("div", { class: "page-row" },
        h("span", { class: "site-dot", attrs: { "aria-hidden": "true" }, text: site.charAt(0).toUpperCase() }),
        h("div", { class: "page-text" },
          h("p", { class: "eyebrow", text: site }),
          h("h1", { class: "page-title", id: "screen-title", attrs: { tabindex: "-1" }, text: cleanTabTitle(v.tabTitle) || v.url || "Untitled page" }),
        ),
      ),
    ),
  );
  if (a.kind !== "ok") {
    out.push(h("div", { class: "banner banner-note" }, h("p", { text: a.reason })));
    out.push(button("Paste job text", startManual, { kind: "primary", id: "btn-manual" }));
  } else {
    if (v.lookup) {
      const l = v.lookup;
      out.push(
        h(
          "div",
          { class: "card existing" },
          h("p", { class: "existing-t", text: l.saved ? "★ Already saved in your jobs" : "Already in your jobs" }),
          h(
            "div",
            { class: "row" },
            l.latestAnalysisId ? button("View your fit", () => viewExisting(l.id), { kind: "primary", id: "btn-view-existing" }) : null,
            button("Open in dashboard", () => openTab(dashboardUrl(l.id)), { kind: "quiet" }),
          ),
        ),
      );
    }
    if (!v.lookup) {
      out.push(
        h(
          "section",
          { class: "coachcard mood-wave", attrs: { "aria-label": "Eli, your coach" } },
          h(
            "div",
            { class: "coach-row" },
            h("div", { class: "coach-avatar" }, avatar("wave", 60)),
            h(
              "div",
              { class: "bubble" },
              h("p", { class: "bubble-hi", text: "Hi, I'm Eli." }),
              h("p", { class: "bubble-verdict", text: "Tap Analyze and I'll check this job against your resume: what you have, what's missing, and what to do next." }),
            ),
          ),
        ),
      );
    }
    out.push(
      h(
        "div",
        { class: "cta" },
        button(v.lookup ? "Analyze again" : "Analyze this job", () => void readPage(true), { kind: v.lookup?.latestAnalysisId ? "secondary" : "primary", id: "btn-analyze" }),
        h("p", { class: "cta-hint", text: "Takes a few seconds. Compares the posting with your resume." }),
        h("div", { class: "cta-alt" },
          button("Review text first", () => void readPage(false), { kind: "quiet", id: "btn-review" }),
          h("span", { class: "dotsep", attrs: { "aria-hidden": "true" }, text: "·" }),
          button("Paste text", startManual, { kind: "quiet", id: "btn-manual" }),
        ),
      ),
    );
    if (!v.lookup) {
      out.push(
        h(
          "section",
          { class: "benefits", attrs: { "aria-labelledby": "benefits-h" } },
          h("h2", { class: "section-h", id: "benefits-h", text: "What you'll get" }),
          h(
            "ul",
            { class: "plain" },
            benefit("◎", "Your fit, requirement by requirement", "See which must-haves your resume already shows and which it doesn't."),
            benefit("↗", "What to work on next", "Your gaps become a prep plan sized to your weekly hours."),
            benefit("❝", "Interview practice for this role", "Questions matched to the job, with feedback on your answers."),
          ),
        ),
      );
    }
    out.push(h("p", { class: "fine", text: "Prepzy reads only this tab, only when you click. It never reads form fields, passwords or cookies." }));
  }
  const recent = recentList();
  if (recent) out.push(recent);
  return out;
}

function field(label: string, id: string, value: string, onInput: (s: string) => void, max = 300): HTMLElement {
  return h(
    "div",
    { class: "field" },
    h("label", { for: id, text: label }),
    h("input", { id, type: "text", value, attrs: { maxlength: max, autocomplete: "off", spellcheck: "false" }, on: { input: (e) => onInput((e.target as HTMLInputElement).value) } }),
  );
}

function renderPreview(): HTMLElement[] {
  const d = v.draft!;
  const ext = v.extraction && v.norm && d.url === v.norm ? v.extraction : null;
  const verdict = ext ? verdictFor(ext) : null;
  const out: HTMLElement[] = [heading("Review before analysing")];

  if (verdict?.kind === "multiple") {
    out.push(
      h(
        "div",
        { class: "banner banner-warn", attrs: { role: "status" } },
        h("p", { text: `This page lists ${verdict.count} jobs. To analyse one, select its text on the page and choose Read again, or paste it below.` }),
      ),
    );
  } else if (verdict?.kind === "insufficient") {
    out.push(h("div", { class: "banner banner-warn", attrs: { role: "status" } }, h("p", { text: "Prepzy could not find enough job text on this page. Select the posting text and choose Read again, or paste it below." })));
  }

  if (ext) {
    out.push(
      h(
        "dl",
        { class: "facts" },
        h("dt", { text: "Read with" }),
        h("dd", { text: adapterLabel(ext.adapter) }),
        h("dt", { text: "Structured data" }),
        h("dd", { text: ext.jsonLd.found ? `JSON-LD JobPosting found${ext.jsonLd.count > 1 ? ` (${ext.jsonLd.count})` : ""}` : "None found" }),
        h("dt", { text: "Location" }),
        h("dd", { text: ext.location ?? "Not stated" }),
      ),
    );
  }

  out.push(
    field("Job title", "f-title", d.title, (s) => {
      d.title = s;
      persistDraft();
    }),
  );
  out.push(
    field("Company", "f-company", d.company, (s) => {
      d.company = s;
      persistDraft();
    }),
  );

  // Text source choice
  const options: { id: TextSource; label: string; enabled: boolean }[] = [];
  if (ext) {
    options.push({ id: "page", label: `Page text (${ext.textLength.toLocaleString()} characters${ext.truncated ? ", truncated" : ""})`, enabled: verdict?.kind === "ok" });
    if (ext.selection) options.push({ id: "selection", label: `Selected text (${ext.selection.length.toLocaleString()} characters)`, enabled: true });
  }
  options.push({ id: "manual", label: "Paste or edit the text myself", enabled: true });
  out.push(
    h(
      "fieldset",
      { class: "choices" },
      h("legend", { text: "Text to analyse" }),
      options.map((o) =>
        h(
          "label",
          { class: `choice${o.enabled ? "" : " is-disabled"}` },
          h("input", {
            type: "radio",
            name: "source",
            id: `src-${o.id}`,
            checked: d.source === o.id,
            disabled: !o.enabled,
            on: {
              change: () => {
                d.source = o.id;
                if (o.id === "manual" && !d.manualText && ext) d.manualText = ext.selection || ext.text;
                persistDraft();
                render();
              },
            },
          }),
          h("span", { text: o.label }),
        ),
      ),
    ),
  );

  if (d.source === "manual") {
    const count = h("p", { class: "meta", id: "manual-count", text: countText(d.manualText.length) });
    out.push(
      h(
        "div",
        { class: "field" },
        h("label", { for: "manual-text", text: "Job text" }),
        h("textarea", {
          id: "manual-text",
          value: d.manualText,
          attrs: { rows: 9, maxlength: 60000, spellcheck: "false", "aria-describedby": "manual-count" },
          on: {
            input: (e) => {
              d.manualText = (e.target as HTMLTextAreaElement).value;
              count.textContent = countText(d.manualText.length);
              persistDraft();
              const btn = document.getElementById("btn-submit") as HTMLButtonElement | null;
              if (btn) btn.disabled = !canSubmit();
            },
          },
        }),
        count,
      ),
    );
  } else if (ext) {
    const text = d.source === "selection" ? ext.selection ?? "" : ext.text;
    out.push(
      h(
        "figure",
        { class: "excerpt" },
        h("figcaption", { class: "meta", text: `First ${Math.min(600, text.length)} of ${text.length.toLocaleString()} characters` }),
        h("blockquote", { text: text.slice(0, 600) + (text.length > 600 ? "…" : "") }),
      ),
    );
  }

  out.push(
    h(
      "label",
      { class: "check" },
      h("input", {
        type: "checkbox",
        id: "f-save",
        checked: d.save,
        on: {
          change: (e) => {
            d.save = (e.target as HTMLInputElement).checked;
            persistDraft();
          },
        },
      }),
      h("span", { text: "Also save to my jobs" }),
    ),
  );

  out.push(
    h(
      "div",
      { class: "actions" },
      button("Analyze", () => void submit(), { kind: "primary", id: "btn-submit", disabled: !!v.busy || !canSubmit() }),
      v.access.kind === "ok" ? button("Read again", () => void readPage(), { id: "btn-reread" }) : null,
      button(
        "Back",
        () => {
          discardDraft();
          void load();
        },
        { kind: "quiet" },
      ),
    ),
  );
  return out;
}

function countText(n: number): string {
  return n < MIN_TEXT ? `${n.toLocaleString()} characters — at least ${MIN_TEXT} needed` : `${n.toLocaleString()} characters`;
}

function adapterLabel(a: string): string {
  const map: Record<string, string> = {
    jsonld: "Page metadata (JSON-LD)",
    linkedin: "LinkedIn layout",
    indeed: "Indeed layout",
    naukri: "Naukri layout",
    greenhouse: "Greenhouse layout",
    lever: "Lever layout",
    generic: "General page text",
    none: "Nothing usable found",
  };
  if (a.endsWith("heading")) return "Job description section";
  return map[a] ?? a;
}

function canSubmit(): boolean {
  const d = v.draft;
  if (!d) return false;
  if (d.source === "manual") return d.manualText.trim().length >= MIN_TEXT;
  const ext = v.extraction;
  if (!ext) return false;
  if (d.source === "selection") return !!ext.selection && ext.selection.length >= MIN_TEXT;
  return verdictFor(ext).kind === "ok";
}

const PROGRESS_STEPS = ["Reading the job posting", "Finding the requirements", "Comparing with your resume", "Building your plan"];

function renderProgress(): HTMLElement[] {
  const r = v.record!;
  const stage = stageLabel(r.stage);
  // 0-based step in progress: the posting is already read once it reaches the server; the model then
  // extracts requirements, and the match/plan are built when it finishes.
  const active = r.state !== "queued" && /match|compar|scor/i.test(r.stage ?? "") ? 2 : 1;
  const secs = Math.max(0, Math.round((Date.now() - r.startedAt) / 1000));
  const out: HTMLElement[] = [
    h("section", { class: "working", attrs: { "aria-labelledby": "screen-title" } },
      h("div", { class: "working-head" },
        h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
        h("div", {},
          h("h1", { class: "working-title", id: "screen-title", text: stateLabel(r.state), attrs: { tabindex: "-1" } }),
          h("p", { class: "working-job", text: r.title || hostOf(r.url) || "Pasted job text" }))),
      h("ol", { class: "steps-track" }, PROGRESS_STEPS.map((label, i) =>
        h("li", { class: `track-step ${i < active ? "is-done" : i === active ? "is-active" : ""}` },
          h("span", { class: "track-dot", attrs: { "aria-hidden": "true" }, text: i < active ? "\u2713" : String(i + 1) }),
          h("span", { text: label }),
          i === active ? h("span", { class: "sr-only", text: " (in progress)" }) : null))),
      h("div", { class: "scanbar", attrs: { "aria-hidden": "true" } }, h("span")),
      h("p", { class: "working-hint", text: `Usually 5\u201320 seconds${secs >= 3 ? ` \u00b7 ${secs}s so far` : ""}` }),
      h("p", { class: "fine", text: stage ? `Server stage: ${stage}` : "Waiting for the server" }),
      r.attempt > 1 ? h("p", { class: "fine", text: `Attempt ${r.attempt}${r.maxAttempts ? ` of ${r.maxAttempts}` : ""}` }) : null,
    ),
  ];
  out.push(
    h("section", { class: "preview-skel", attrs: { "aria-hidden": "true" } },
      h("p", { class: "skel-title", text: "Getting your results ready" }),
      ...[["Match", "How well your resume fits"], ["Prepare", "Your plan for the gaps"], ["Interview", "What past candidates were asked"]].map(([t, d]) =>
        h("div", { class: "skel-row" },
          h("span", { class: "skel-icon" }),
          h("div", { class: "skel-text" }, h("span", { class: "skel-name", text: t }), h("span", { class: "skel-desc", text: d })),
          h("span", { class: "skel-bar" })))),
  );
  if (r.state === "cancellation-requested") {
    out.push(h("p", { class: "prose", text: "Cancellation requested. The server stops at its next checkpoint, and the analysis may still finish." }));
  }
  if (v.connectionLost) {
    out.push(
      h(
        "div",
        { class: "banner banner-warn", attrs: { role: "status" } },
        h("p", { text: "Connection lost \u2014 still processing on the server?" }),
        button("Check again", () => void checkAgain(), { id: "btn-check" }),
      ),
    );
  }
  out.push(
    h(
      "div",
      { class: "actions" },
      r.state !== "cancellation-requested" ? button("Cancel", () => void cancelCapture(), { kind: "danger", id: "btn-cancel" }) : null,
      button("Open in dashboard", () => openTab(dashboardUrl(r.jobId)), { kind: "quiet" }),
    ),
  );
  out.push(h("p", { class: "fine", text: "You can close this window. Prepzy keeps working and marks the toolbar icon when it finishes." }));
  return out;
}

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ------------------------------------------------------------------ result screen (coach + checklist)

const BUCKET_UI: Record<Bucket, { title: string; glyph: string }> = {
  have: { title: "You have", glyph: "✓" },
  partly: { title: "Partly shown", glyph: "◐" },
  missing: { title: "Missing from your resume", glyph: "✕" },
  check: { title: "Check yourself", glyph: "?" },
};

function jobLine(job: JobView): HTMLElement {
  const f = job.analysis?.fields;
  const title = f?.title.value ?? job.job.title ?? "Untitled job";
  const company = f?.company.value ?? job.job.company;
  const meta = [company, f?.location.value, f?.work_mode.value ? cap(f.work_mode.value) : null, f?.experience.value]
    .filter((x): x is string => !!x)
    .join(" · ");
  return h(
    "section",
    { class: "jobline", attrs: { "aria-label": "Job" } },
    h("h1", { class: "jobline-title", id: "screen-title", text: title, attrs: { tabindex: "-1" } }),
    meta ? h("p", { class: "jobline-meta", text: meta }) : null,
    f?.salary.value ? h("p", { class: "jobline-pay", text: f.salary.value }) : null,
  );
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function runCoachAction(action: string, job: JobView): void {
  const web = v.state?.webBase ?? WEB_BASE;
  const report = dashboardUrl(job.job.id) ?? web;
  if (action === "practice") openTab(`${web}/interviews/new?job_id=${job.job.id}`);
  else if (action === "plan") openTab(`${web}/preparation?job_id=${job.job.id}`);
  else if (action === "resume") openTab(`${web}/resumes`);
  else if (action === "analyze") void startOver();
  else openTab(report);
}

function coachCard(job: JobView, items: ChecklistItem[]): HTMLElement {
  const a = job.analysis!;
  const line = coach({
    name: null,
    company: a.fields.company.value ?? job.job.company,
    items,
    match: v.match,
    partial: a.status === "partial",
  });
  return h(
    "section",
    { class: `coachcard mood-${line.mood}`, attrs: { "aria-labelledby": "coach-say" } },
    h(
      "div",
      { class: "coach-row" },
      h("div", { class: "coach-avatar" }, avatar(line.mood, 60)),
      h(
        "div",
        { class: "bubble", id: "coach-say", attrs: { role: "status" } },
        h("p", { class: "bubble-hi", text: line.greeting }),
        h("p", { class: "bubble-verdict", text: line.verdict }),
        line.advice ? h("p", { class: "bubble-advice", text: line.advice }) : null,
      ),
    ),
    line.primary || line.secondary
      ? h(
          "div",
          { class: "coach-actions" },
          line.primary ? button(line.primary.label, () => runCoachAction(line.primary!.action, job), { kind: "primary", id: "btn-coach-primary", disabled: false }) : null,
          line.secondary ? button(line.secondary.label, () => runCoachAction(line.secondary!.action, job), { kind: "secondary", id: "btn-coach-secondary", disabled: false }) : null,
        )
      : null,
  );
}

function progressStrip(items: ChecklistItem[]): HTMLElement | null {
  const must = items.filter((i) => i.importance === "required");
  const pool = must.length ? must : items;
  const assessed = pool.filter((i) => i.bucket !== "check");
  if (!v.match?.hasResume || !assessed.length) return null;
  const have = assessed.filter((i) => i.bucket === "have").length;
  const order: Bucket[] = ["have", "partly", "missing"];
  const segs = [...assessed].sort((x, y) => order.indexOf(x.bucket) - order.indexOf(y.bucket));
  return h(
    "div",
    { class: "strip" },
    h("p", { class: "strip-text" }, h("strong", { text: `${have} of ${assessed.length}` }), ` ${must.length ? "must-haves" : "requirements"} on your resume`),
    h(
      "div",
      { class: "segs", attrs: { role: "img", "aria-label": `${have} of ${assessed.length} shown on your resume` } },
      segs.map((i) => h("span", { class: `seg seg-${i.bucket}`, attrs: { title: `${i.label}: ${BUCKET_UI[i.bucket].title}` } })),
    ),
  );
}

function checklist(items: ChecklistItem[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  const order: Bucket[] = v.match?.hasResume ? ["missing", "partly", "have", "check"] : ["check"];
  for (const b of order) {
    const group = items.filter((i) => (v.match?.hasResume ? i.bucket === b : true));
    if (!group.length) continue;
    group.sort((x, y) => (x.importance === "required" ? 0 : 1) - (y.importance === "required" ? 0 : 1));
    const title = v.match?.hasResume ? BUCKET_UI[b].title : "What this job asks for";
    out.push(
      h(
        "section",
        { class: `checks checks-${b}`, attrs: { "aria-labelledby": `chk-${b}` } },
        h("h2", { class: "checks-h", id: `chk-${b}` }, h("span", { text: title }), h("span", { class: "checks-n", text: String(group.length) })),
        h(
          "ul",
          { class: "checks-list" },
          group.map((i) =>
            h(
              "li",
              { class: "check-row" },
              h("span", { class: `check-dot dot-${v.match?.hasResume ? i.bucket : "check"}`, attrs: { "aria-hidden": "true" }, text: v.match?.hasResume ? BUCKET_UI[i.bucket].glyph : "•" }),
              h(
                "div",
                { class: "check-body" },
                h(
                  "p",
                  { class: "check-label" },
                  i.label,
                  i.importance === "preferred" ? h("span", { class: "check-tag", text: "nice to have" }) : null,
                  i.note ? h("span", { class: "check-note", text: i.note }) : null,
                ),
                i.detail ? h("p", { class: "check-detail", text: i.detail }) : null,
              ),
            ),
          ),
        ),
      ),
    );
  }
  return out;
}

function trackRow(job: JobView): HTMLElement {
  const status = v.application?.status ?? null;
  return h(
    "section",
    { class: "trackrow", attrs: { "aria-label": "Track this job" } },
    button(job.job.saved ? "★ Saved" : "☆ Save", () => void toggleSave(), { pressed: job.job.saved, id: "btn-save" }),
    h(
      "div",
      { class: "seg-ctl", attrs: { role: "group", "aria-label": "Application status" } },
      button("Planning", () => void setStatus("planned"), { pressed: status === "planned", id: "btn-planned" }),
      button("Applied", () => void setStatus("applied"), { pressed: status === "applied", id: "btn-applied" }),
    ),
    button("Full report", () => openTab(dashboardUrl(job.job.id)), { kind: "quiet", id: "btn-dashboard", disabled: false }),
  );
}

function trackDetails(job: JobView): HTMLElement {
  const noteArea = h("textarea", { id: "note-body", attrs: { rows: 3, maxlength: 20000, placeholder: "Anything to remember about this job" } });
  const remTitle = h("input", { id: "rem-title", type: "text", value: `Follow up: ${job.job.title ?? "job"}`.slice(0, 300), attrs: { maxlength: 300 } });
  const remDate = h("input", { id: "rem-date", type: "date", value: todayIso(), attrs: { min: todayIso(), required: true } });
  const remTime = h("input", { id: "rem-time", type: "time", value: "09:00", attrs: { required: true } });
  return h(
    "details",
    { class: "fold" },
    h("summary", { text: "Add a note or reminder" }),
    h("div", { class: "field" }, h("label", { for: "note-body", text: "Note" }), noteArea),
    button("Save note", () => {
      const body = noteArea.value.trim();
      if (!body) return;
      void addNote(body, () => (noteArea.value = ""));
    }),
    h("div", { class: "field" }, h("label", { for: "rem-title", text: "Reminder" }), remTitle),
    h("div", { class: "row" }, h("div", { class: "field" }, h("label", { for: "rem-date", text: "Date" }), remDate), h("div", { class: "field" }, h("label", { for: "rem-time", text: "Time" }), remTime)),
    button("Set reminder", () => {
      if (!remTitle.value.trim() || !remDate.value || !remTime.value) {
        v.error = { code: "invalid", message: "Enter a reminder title, date and time.", requestId: null, retryable: false };
        render();
        return;
      }
      void addReminder(remTitle.value.trim(), remDate.value, remTime.value.slice(0, 5));
    }),
  );
}

function plainIssue(i: { code: string; message: string }): string {
  const map: Record<string, string> = {
    rules_gap_fill: "Some requirements were picked up from the posting's sections because the AI skipped them.",
    unsupported_field: "A detail the AI suggested wasn't in the posting, so it was left out.",
    unsupported_requirement: "Some AI-suggested requirements weren't in the posting and were removed.",
    truncated: "The posting was very long, so only the first part was analysed.",
    multiple_jobs: "This text may contain more than one job.",
    conflict: "The page's metadata and visible text disagree on a detail.",
  };
  return map[i.code] ?? i.message;
}

function aboutDetails(job: JobView): HTMLElement {
  const a = job.analysis!;
  const bits = [a.model && a.model !== "none" ? `Model ${a.model}` : "No AI model used", a.promptVersion, a.schemaVersion].filter(Boolean).join(" · ");
  return h(
    "details",
    { class: "fold" },
    h("summary", { text: "How Eli worked this out" }),
    h("p", { class: "meta", text: "Every requirement is quoted from the posting and checked against the evidence in your resume. It's an estimate, not a hiring prediction." }),
    a.issues.length ? h("ul", { class: "plain notes" }, a.issues.map((i) => h("li", { text: plainIssue(i) }))) : null,
    h("p", { class: "fine", text: `${bits}. ${job.historyCount} ${job.historyCount === 1 ? "analysis" : "analyses"} of this job.` }),
    button("Analyze this page again", () => void startOver(), { kind: "quiet" }),
  );
}

function renderResult(): HTMLElement[] {
  const r = v.record;
  const out: HTMLElement[] = [];
  if (r && (r.state === "failed" || r.state === "timed-out")) {
    out.push(
      h(
        "section",
        { class: "coachcard mood-think" },
        h(
          "div",
          { class: "coach-row" },
          h("div", { class: "coach-avatar" }, avatar("think", 52)),
          h(
            "div",
            { class: "bubble", attrs: { role: "alert" } },
            h("p", { class: "bubble-hi", id: "screen-title", text: r.state === "timed-out" ? "That took too long." : "I couldn't finish that one.", attrs: { tabindex: "-1" } }),
            h("p", { class: "bubble-verdict", text: r.error?.message ?? "The analysis did not finish." }),
            r.error?.code?.startsWith("model") ? h("p", { class: "bubble-advice", text: "The AI model may still be starting. Your job text is saved; retry in a minute." }) : null,
          ),
        ),
        h(
          "div",
          { class: "coach-actions" },
          isRetryable(r.state) ? button("Try again", () => void retryCapture(), { kind: "primary", id: "btn-retry" }) : null,
          button("Start over", () => void startOver(), { kind: "secondary" }),
        ),
      ),
    );
    return out;
  }
  if (r && r.state === "cancelled") {
    out.push(heading("Cancelled"));
    out.push(h("p", { class: "prose", text: "The analysis was cancelled. The captured text is kept in your jobs." }));
    out.push(h("div", { class: "actions" }, button("Analyze again", () => void startOver(), { kind: "primary" })));
    return out;
  }
  const job = v.job;
  if (!job) {
    out.push(heading("Analysis"));
    out.push(h("p", { class: "meta", text: v.error ? "The analysis could not be loaded." : "Loading the analysis…" }));
    if (v.error && v.resultJobId) out.push(button("Try again", () => void loadJob(v.resultJobId!, v.seq)));
    return out;
  }
  out.push(jobLine(job));
  const a = job.analysis;
  if (!a) {
    out.push(h("p", { class: "meta", text: "This job has no analysis yet." }));
    out.push(trackRow(job));
    return out;
  }
  if (a.stale) out.push(h("div", { class: "banner banner-note" }, h("p", { text: "This page has changed since this analysis." })));
  const items = buildChecklist(a.requirements, v.match);
  out.push(coachCard(job, items));
  // Four focused tabs instead of one long page. Every panel stays in the DOM (inactive ones hidden)
  // so switching is instant and nothing typed into a note or reminder is lost.
  const strip = progressStrip(items);
  const lists = checklist(items);
  const research = researchCard(job);
  const panels: Record<ResultTab, (HTMLElement | null)[]> = {
    match: [strip, ...(lists.length ? lists : [h("p", { class: "meta", text: "No requirements were found in this posting." })]), aboutDetails(job)],
    prepare: [prepareCard(job, items)],
    interviews: research ? [research] : [h("p", { class: "meta", text: "Interview links appear once the company or role is known." })],
    track: [trackRow(job), trackDetails(job)],
  };
  out.push(resultTabs(items));
  for (const id of RESULT_TABS.map((t) => t.id)) {
    out.push(h("div", { class: "tabpanel", id: `panel-${id}`, attrs: { role: "tabpanel", "aria-labelledby": `tab-${id}`, hidden: v.resultTab !== id } },
      ...panels[id]));
  }
  return out;
}

const RESULT_TABS: { id: ResultTab; label: string }[] = [
  { id: "match", label: "Match" },
  { id: "prepare", label: "Prepare" },
  { id: "interviews", label: "Interviews" },
  { id: "track", label: "Track" },
];

function resultTabs(items: ChecklistItem[]): HTMLElement {
  const gaps = v.match?.hasResume ? items.filter((i) => i.bucket === "missing" || i.bucket === "partly").length : 0;
  const select = (id: ResultTab) => {
    v.resultTab = id;
    render();
    document.getElementById(`tab-${id}`)?.focus();
  };
  return h("div", { class: "tabs", attrs: { role: "tablist", "aria-label": "Result sections" } },
    RESULT_TABS.map((t, i) => h("button", {
      type: "button", class: "tab", id: `tab-${t.id}`,
      attrs: { role: "tab", "aria-selected": v.resultTab === t.id ? "true" : "false", "aria-controls": `panel-${t.id}`, tabindex: v.resultTab === t.id ? "0" : "-1" },
      on: {
        click: () => select(t.id),
        keydown: (ev) => {
          const k = (ev as KeyboardEvent).key;
          if (k === "ArrowRight" || k === "ArrowLeft") {
            ev.preventDefault();
            const n = RESULT_TABS[(i + (k === "ArrowRight" ? 1 : RESULT_TABS.length - 1)) % RESULT_TABS.length]!;
            select(n.id);
          }
        },
      },
    }, t.label, t.id === "prepare" && gaps ? h("span", { class: "tab-badge", text: String(gaps), attrs: { "aria-label": `${gaps} gaps` } }) : null)));
}

/** What to do next: the biggest gaps first, then the plan and practice built from this job. */
function prepareCard(job: JobView, items: ChecklistItem[]): HTMLElement {
  const rank = (i: ChecklistItem) => (i.importance === "required" ? 0 : 1) + (i.bucket === "missing" ? 0 : 0.5);
  const gaps = v.match?.hasResume
    ? items.filter((i) => i.bucket === "missing" || i.bucket === "partly").sort((x, y) => rank(x) - rank(y)).slice(0, 3)
    : [];
  const topics = [...items].sort((x, y) => (x.importance === "required" ? 0 : 1) - (y.importance === "required" ? 0 : 1))
    .map((i) => i.label).filter((l, k, all) => all.indexOf(l) === k).slice(0, 6);
  return h(
    "section",
    { class: "prep", attrs: { "aria-labelledby": "prep-h" } },
    h("h2", { class: "section-h", id: "prep-h", text: "Your preparation plan" }),
    gaps.length
      ? h("ol", { class: "prep-steps" }, gaps.map((g, k) =>
          h("li", {}, h("span", { class: "prep-n", text: String(k + 1), attrs: { "aria-hidden": "true" } }),
            h("span", {}, h("strong", { text: g.label }), g.bucket === "partly" ? " · strengthen the evidence" : " · learn and add proof to your resume"))))
      : h("p", { class: "meta", text: v.match?.hasResume ? "Your resume covers the stated requirements. Practise explaining them with examples." : "Add your resume on the website to see your personal gaps." }),
    topics.length
      ? h("div", { class: "topics" },
          h("p", { class: "topics-h", text: "Likely interview topics (from this job's requirements)" }),
          h("ul", { class: "chips" }, topics.map((t) => h("li", { class: "chip", text: t }))))
      : null,
    h("div", { class: "row prep-actions" },
      button("Build my study plan", () => runCoachAction("plan", job), { kind: "primary", id: "btn-plan" }),
      button("Practise interview", () => runCoachAction("practice", job), { kind: "secondary", id: "btn-practice" }),
    ),
  );
}

/** Real interview experiences, read by the user on each site (Prepzy never scrapes them). */
function researchCard(job: JobView): HTMLElement | null {
  const f = job.analysis?.fields;
  const links = interviewResearchLinks(f?.company.value ?? job.job.company, f?.title.value ?? job.job.title);
  if (!links.length) return null;
  return h(
    "details",
    { class: "fold research", attrs: { open: "" } },
    h("summary", { text: "Real interview experiences" }),
    h("p", { class: "meta", text: "Opens searches on each site in a new tab, for this company and role. Prepzy doesn't copy or summarise these sites." }),
    h("ul", { class: "research-list" }, links.map((l) =>
      h("li", {}, h("button", { class: "research-link", type: "button", attrs: { "data-id": l.id }, on: { click: () => openTab(l.url) } },
        h("span", { class: "research-name", text: l.label }), h("span", { class: "research-hint", text: l.hint }), h("span", { attrs: { "aria-hidden": "true" }, text: "↗" }))))),
  );
}

let lastScreen: Screen | null = null;

/** Glowing edge around the extension window itself: animated while a job is analysed, a short green
 * (or red) flash when it finishes. Nothing is drawn on the job website. */
function edgeGlowMode(): "active" | "done" | "error" | "off" {
  const r = v.record;
  if (!r) return "off";
  if (r.state === "queued" || r.state === "analyzing" || r.state === "cancellation-requested") return "active";
  const recent = Date.now() - (r.updatedAt ?? 0) < 8000;
  if (!recent) return "off";
  if (r.state === "completed" || r.state === "partial-result") return "done";
  if (r.state === "failed" || r.state === "timed-out") return "error";
  return "off";
}

function syncEdgeGlow(): void {
  const mode = edgeGlowMode();
  for (const id of ["edge-halo", "edge-glow"]) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.setAttribute("aria-hidden", "true");
      document.body.append(el);
    }
    if (el.dataset.mode !== mode) el.dataset.mode = mode;
  }
}

function render(): void {
  syncEdgeGlow();
  const focusedId = document.activeElement instanceof HTMLElement ? document.activeElement.id : "";
  const openDetails = Array.from(document.querySelectorAll("details[open] > summary")).map((s) => s.textContent);
  const scroll = root.scrollTop;
  clear(root);
  root.setAttribute("aria-busy", v.busy ? "true" : "false");
  let body: (HTMLElement | null)[] = [];
  switch (v.screen) {
    case "loading":
      body = [h("p", { class: "meta", text: "Loading…" })];
      break;
    case "signed-out":
      body = renderSignedOut();
      break;
    case "main":
      body = renderMain();
      break;
    case "preview":
      body = v.draft ? renderPreview() : renderMain();
      break;
    case "progress":
      body = v.record ? renderProgress() : renderMain();
      break;
    case "result":
      body = renderResult();
      break;
  }
  root.append(header(), h("main", { class: "content" }, ...banners().filter((x): x is HTMLElement => !!x), ...body.filter((x): x is HTMLElement => !!x)));
  for (const s of Array.from(root.querySelectorAll("details > summary"))) if (openDetails.includes(s.textContent)) s.parentElement?.setAttribute("open", "");
  if (lastScreen !== v.screen) {
    lastScreen = v.screen;
    document.getElementById("screen-title")?.focus({ preventScroll: true });
    root.scrollTop = 0;
  } else {
    root.scrollTop = scroll;
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }
}

// ------------------------------------------------------------------ live updates

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "auth" in changes) {
    const signedInNow = !!changes.auth?.newValue;
    if (signedInNow !== !!v.state?.signedIn || (changes.auth?.oldValue as { userId?: string } | undefined)?.userId !== (changes.auth?.newValue as { userId?: string } | undefined)?.userId) {
      void load();
    }
    return;
  }
  if (area === "session" && "captures" in changes && (v.screen === "progress" || v.screen === "result") && v.record) {
    const map = changes.captures?.newValue as Record<string, CaptureRecord> | undefined;
    const next = map?.[v.record.captureId];
    // Same capture, same tab + URL, newer sequence only.
    if (next && next.seq > v.record.seq && next.tabId === v.tabId && next.url === v.norm) showRecord(next);
  }
});

chrome.tabs.onActivated.addListener(() => void load());
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === v.tabId && (info.url !== undefined || info.status === "complete")) {
    // Navigation within the same tab: never keep showing the previous page's state.
    void (async () => {
      const t = await activeTab();
      if (t?.id === v.tabId && normalizeUrl(t?.url) !== v.norm) void load();
    })();
  }
});

window.addEventListener("pagehide", stopPolling);

void load();

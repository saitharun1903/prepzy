// Popup + side panel UI (same app; layout adapts to the container).
// The UI never talks to the API: every action is a typed message to the service worker.

import { CONNECT_PAGE, WEB_BASE } from "../config";
import { MIN_TEXT, verdictFor, type ExtractResult } from "../shared/extract";
import {
  shortLabel,
  splitRequirements,
  type ApplicationView,
  type FitGroup,
  type FitStatus,
  type JobView,
  type LookupView,
  type MatchView,
  type RequirementView,
} from "../shared/jobview";
import type { ErrorInfo, Reply, ReplyMap, StateData, TextSource, UiRequest } from "../shared/messages";
import { isActive, isRetryable, isTerminal, pollDelayMs, stageLabel, stateLabel, type CaptureRecord } from "../shared/state";
import { classifyUrl, dashboardJobUrl, hostOf, normalizeUrl, type PageAccess } from "../shared/url";
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
}

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
    handleAuthError(e);
  }
  if (v.screen === "main") render();
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
  run("Sending to Elevate", async () => {
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

function header(): HTMLElement {
  const signedIn = !!v.state?.signedIn;
  const email = v.state?.email ?? "";
  return h(
    "header",
    { class: "top" },
    h("div", { class: "brand" }, h("span", { class: "mark", attrs: { "aria-hidden": "true" }, text: "E" }), h("span", { class: "wordmark", text: "Elevate" })),
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
          v.error.requestId ? h("p", { class: "meta" }, "Request ID: ", h("code", { text: v.error.requestId })) : null,
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

function renderSignedOut(): HTMLElement[] {
  return [
    heading("Connect Elevate"),
    h(
      "div",
      { class: "prose" },
      h("p", { text: "Elevate reads a job posting only when you ask it to, and sends it to your Elevate account for an evidence-based analysis." }),
      h(
        "ol",
        { class: "steps" },
        h("li", { text: "Open the Elevate dashboard and sign in." }),
        h("li", { text: "Approve the connection on the Connect extension page." }),
        h("li", { text: "Come back here. Your password is never shared with the extension." }),
      ),
    ),
    button("Open the connect page", () => openTab(CONNECT_PAGE), { kind: "primary", id: "btn-connect", disabled: false }),
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
    out.push(
      h(
        "div",
        { class: "cta" },
        button(v.lookup ? "Analyze again" : "Analyze this job", () => void readPage(true), { kind: v.lookup?.latestAnalysisId ? "secondary" : "primary", id: "btn-analyze" }),
        h("p", { class: "cta-hint", text: "Takes about a minute on your computer. Compares the posting with your resume." }),
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
    out.push(h("p", { class: "fine", text: "Elevate reads only this tab, only when you click. It never reads form fields, passwords or cookies." }));
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
    out.push(h("div", { class: "banner banner-warn", attrs: { role: "status" } }, h("p", { text: "Elevate could not find enough job text on this page. Select the posting text and choose Read again, or paste it below." })));
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

function renderProgress(): HTMLElement[] {
  const r = v.record!;
  const stage = stageLabel(r.stage);
  const out: HTMLElement[] = [
    heading(stateLabel(r.state)),
    h(
      "section",
      { class: "card progress", attrs: { "aria-label": "Analysis status" } },
      h("p", { class: "eyebrow", text: r.title || hostOf(r.url) || "Pasted text" }),
      h("p", { class: "stage" }, h("span", { class: "dot", attrs: { "aria-hidden": "true" } }), stage ? `Server stage: ${stage}` : "Waiting for the server"),
      r.attempt > 1 ? h("p", { class: "meta", text: `Attempt ${r.attempt}${r.maxAttempts ? ` of ${r.maxAttempts}` : ""}` }) : null,
      h("p", { class: "meta", text: `Started ${new Date(r.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` }),
    ),
  ];
  if (r.state === "cancellation-requested") {
    out.push(h("p", { class: "prose", text: "Cancellation requested. The server stops at its next checkpoint, and the analysis may still finish." }));
  }
  if (v.connectionLost) {
    out.push(
      h(
        "div",
        { class: "banner banner-warn", attrs: { role: "status" } },
        h("p", { text: "Connection lost — still processing on the server?" }),
        button("Check again", () => void checkAgain(), { id: "btn-check" }),
      ),
    );
  }
  out.push(
    h(
      "div",
      { class: "actions" },
      r.state !== "cancellation-requested" ? button("Cancel analysis", () => void cancelCapture(), { kind: "danger", id: "btn-cancel" }) : null,
      button("Open in dashboard", () => openTab(dashboardUrl(r.jobId)), { kind: "quiet" }),
    ),
  );
  out.push(h("p", { class: "fine", text: "You can close this window. Elevate keeps tracking the analysis and marks the toolbar icon when it finishes." }));
  return out;
}

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ------------------------------------------------------------------ result screen (fit summary)

const FIT_ICON: Record<FitStatus, { glyph: string; label: string; cls: string }> = {
  supported: { glyph: "✓", label: "On your resume", cls: "ok" },
  user_confirmed: { glyph: "✓", label: "Confirmed by you", cls: "ok" },
  partial: { glyph: "◐", label: "Partly shown", cls: "part" },
  adjacent: { glyph: "◐", label: "Related skill only", cls: "part" },
  not_evidenced: { glyph: "✕", label: "Not on your resume", cls: "gap" },
  not_met_confirmed: { glyph: "✕", label: "You said not met", cls: "gap" },
  unassessable: { glyph: "?", label: "Check yourself", cls: "unknown" },
};

function chip(text: string, cls = ""): HTMLElement {
  return h("span", { class: `chip ${cls}`.trim(), text });
}

function jobHero(job: JobView): HTMLElement {
  const f = job.analysis?.fields;
  const title = f?.title.value ?? job.job.title ?? "Untitled job";
  const company = f?.company.value ?? job.job.company;
  const location = f?.location.value;
  const chips: HTMLElement[] = [];
  const add = (val: string | null | undefined, cls = "") => {
    if (val) chips.push(chip(val.length > 40 ? `${val.slice(0, 38)}…` : val, cls));
  };
  const mode = f?.work_mode.value;
  add(mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : null);
  add(f?.employment_type.value);
  add(f?.experience.value);
  add(f?.salary.value, "chip-money");
  if (f?.deadline.value) add(`Apply by ${f.deadline.value}`);
  const initial = (company || title).trim().charAt(0).toUpperCase() || "J";
  return h(
    "section",
    { class: "hero", attrs: { "aria-label": "Job" } },
    h(
      "div",
      { class: "hero-row" },
      h("span", { class: "avatar", attrs: { "aria-hidden": "true" }, text: initial }),
      h(
        "div",
        { class: "hero-text" },
        h("h1", { class: "hero-title", id: "screen-title", text: title, attrs: { tabindex: "-1" } }),
        h("p", { class: "hero-sub", text: [company, location].filter(Boolean).join(" · ") || "Company not stated" }),
      ),
    ),
    chips.length ? h("div", { class: "chips" }, chips) : null,
  );
}

function meter(label: string, g: FitGroup): HTMLElement {
  const pct = g.coverage ?? 0;
  return h(
    "div",
    { class: "meter" },
    h("div", { class: "meter-top" }, h("span", { text: label }), h("span", { class: "meter-val", text: g.total ? `${g.met} of ${g.total} shown` : "—" })),
    h(
      "div",
      { class: "bar", attrs: { role: "img", "aria-label": `${label}: ${g.met} of ${g.total} shown on your resume` } },
      h("span", { class: "bar-fill", attrs: { style: `width:${Math.round(pct)}%` } }),
    ),
  );
}

function fitCard(job: JobView): HTMLElement {
  const m = v.match;
  if (m === undefined) {
    return h("section", { class: "fit card" }, h("p", { class: "eyebrow", text: "How you fit" }), h("p", { class: "meta", text: "Comparing with your resume…" }));
  }
  if (m === null || !m.hasResume) {
    return h(
      "section",
      { class: "fit card fit-empty" },
      h("p", { class: "eyebrow", text: "How you fit" }),
      h("p", { class: "fit-headline", text: "Add your resume to see how you fit" }),
      h("p", { class: "meta", text: "Elevate checks each requirement against the evidence in your resume. Nothing is guessed." }),
      button("Add a resume", () => openTab(`${v.state?.webBase ?? WEB_BASE}/resumes`), { kind: "primary", disabled: false }),
    );
  }
  const req = m.required;
  let headline: string;
  let tone: string;
  if (m.scoreStatus === "withheld" || req.coverage === null) {
    headline = "Not enough information to estimate yet";
    tone = "neutral";
  } else if (req.coverage >= 75) {
    headline = "Strong match on the must-haves";
    tone = "good";
  } else if (req.coverage >= 45) {
    headline = "Partial match: a few gaps to close";
    tone = "mid";
  } else {
    headline = "Several must-haves aren't on your resume yet";
    tone = "low";
  }
  const showScore = req.coverage !== null && m.scoreStatus === "available";
  return h(
    "section",
    { class: `fit card fit-${tone}`, attrs: { "aria-labelledby": "fit-h" } },
    h(
      "div",
      { class: "fit-top" },
      h("div", null, h("p", { class: "eyebrow", id: "fit-h", text: "How you fit" }), h("p", { class: "fit-headline", text: headline })),
      showScore
        ? h(
            "div",
            { class: "score", attrs: { "aria-label": `${Math.round(req.coverage!)} percent of must-haves covered` } },
            h("span", { class: "score-num", text: String(Math.round(req.coverage!)) }),
            h("span", { class: "score-pct", text: "%" }),
          )
        : null,
    ),
    meter("Must-haves", req),
    m.preferred.total ? meter("Nice-to-haves", m.preferred) : null,
    m.scoreStatus === "withheld" && m.withheldReason ? h("p", { class: "meta", text: m.withheldReason }) : null,
    m.missing.length
      ? h("div", { class: "gaps" }, h("p", { class: "gaps-h", text: "To work on" }), h("div", { class: "chips" }, m.missing.slice(0, 6).map((x) => chip(x, "chip-gap"))))
      : null,
    h("p", { class: "fine", text: m.stale ? "Your resume or this job changed since this comparison. Open the full report to refresh it." : "Elevate evidence estimate. Not a hiring prediction." }),
    m.stale ? button("Open full report", () => openTab(`${dashboardUrl(job.job.id)}?tab=match`), { kind: "quiet", disabled: false }) : null,
  );
}

function reqRow(r: RequirementView): HTMLElement {
  const st = v.match?.hasResume ? v.match.status[r.key] : undefined;
  const icon = st ? FIT_ICON[st] : null;
  return h(
    "li",
    { class: `req${icon ? ` req-${icon.cls}` : ""}` },
    h("span", { class: "req-icon", attrs: { "aria-hidden": "true" }, text: icon?.glyph ?? "•" }),
    h(
      "div",
      { class: "req-body" },
      h("span", { class: "req-label", text: shortLabel(r) }),
      icon ? h("span", { class: "sr-only", text: ` (${icon.label})` }) : null,
      shortLabel(r) !== r.text ? h("span", { class: "req-src", text: r.text }) : null,
    ),
    icon ? h("span", { class: `req-tag tag-${icon.cls}`, attrs: { "aria-hidden": "true" }, text: icon.label }) : null,
  );
}

function reqSection(title: string, id: string, reqs: RequirementView[], open = true): HTMLElement | null {
  if (!reqs.length) return null;
  const list = h("ul", { class: "reqs-list" }, reqs.map(reqRow));
  if (open) {
    return h("section", { class: "reqs", attrs: { "aria-labelledby": id } }, h("h2", { class: "section-h", id, text: `${title} · ${reqs.length}` }), list);
  }
  return h("details", { class: "reqs disclosure plain-d" }, h("summary", { text: `${title} · ${reqs.length}` }), list);
}

function nextSteps(job: JobView): HTMLElement {
  const base = dashboardUrl(job.job.id) ?? "";
  const web = v.state?.webBase ?? WEB_BASE;
  const status = v.application?.status ?? null;
  return h(
    "section",
    { class: "next", attrs: { "aria-labelledby": "next-h" } },
    h("h2", { class: "section-h", id: "next-h", text: "Next steps" }),
    button("Open full report", () => openTab(base), { kind: "primary", id: "btn-dashboard", disabled: false }),
    h(
      "div",
      { class: "grid2" },
      button("Practice interview", () => openTab(`${web}/interviews/new?job_id=${job.job.id}`), { id: "btn-practice", disabled: false }),
      button("Build a prep plan", () => openTab(`${web}/preparation?job_id=${job.job.id}`), { id: "btn-plan", disabled: false }),
    ),
    h(
      "div",
      { class: "track" },
      button(job.job.saved ? "★ Saved" : "☆ Save job", () => void toggleSave(), { pressed: job.job.saved, id: "btn-save" }),
      h(
        "div",
        { class: "seg", attrs: { role: "group", "aria-label": "Application status" } },
        button("Planning", () => void setStatus("planned"), { pressed: status === "planned", id: "btn-planned" }),
        button("Applied", () => void setStatus("applied"), { pressed: status === "applied", id: "btn-applied" }),
      ),
    ),
    status && status !== "planned" && status !== "applied" ? h("p", { class: "meta", text: `Application status: ${status}` }) : null,
  );
}

function trackDetails(job: JobView): HTMLElement {
  const noteArea = h("textarea", { id: "note-body", attrs: { rows: 3, maxlength: 20000, placeholder: "Anything to remember about this job" } });
  const remTitle = h("input", { id: "rem-title", type: "text", value: `Follow up: ${job.job.title ?? "job"}`.slice(0, 300), attrs: { maxlength: 300 } });
  const remDate = h("input", { id: "rem-date", type: "date", value: todayIso(), attrs: { min: todayIso(), required: true } });
  const remTime = h("input", { id: "rem-time", type: "time", value: "09:00", attrs: { required: true } });
  return h(
    "details",
    { class: "disclosure" },
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
    { class: "disclosure plain-d" },
    h("summary", { text: "About this analysis" }),
    a.issues.length ? h("ul", { class: "plain notes" }, a.issues.map((i) => h("li", { text: plainIssue(i) }))) : h("p", { class: "meta", text: "No issues were found while analysing." }),
    h("p", { class: "fine", text: `Every requirement above is quoted from the posting. ${bits}. ${job.historyCount} ${job.historyCount === 1 ? "analysis" : "analyses"} of this job.` }),
    button("Analyze this page again", () => void startOver(), { kind: "quiet" }),
  );
}

function renderResult(): HTMLElement[] {
  const r = v.record;
  const out: HTMLElement[] = [];
  if (r && (r.state === "failed" || r.state === "timed-out")) {
    out.push(heading(r.state === "timed-out" ? "The analysis took too long" : "The analysis didn't finish"));
    out.push(
      h(
        "div",
        { class: "banner banner-error", attrs: { role: "alert" } },
        h("p", { text: r.error?.message ?? "The analysis did not finish." }),
        r.error?.code?.startsWith("model") ? h("p", { text: "Make sure Ollama is running, then retry. Your job text is already saved." }) : null,
        r.error?.requestId ? h("p", { class: "meta" }, "Request ID: ", h("code", { text: r.error.requestId })) : null,
      ),
    );
    out.push(
      h(
        "div",
        { class: "actions" },
        isRetryable(r.state) ? button("Retry", () => void retryCapture(), { kind: "primary", id: "btn-retry" }) : null,
        button("Start over", () => void startOver(), { kind: "quiet" }),
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
  const a = job.analysis;
  out.push(jobHero(job));
  if (!a) {
    out.push(h("p", { class: "meta", text: "This job has no analysis yet." }));
    out.push(nextSteps(job));
    return out;
  }
  if (a.status === "partial") {
    out.push(
      h(
        "div",
        { class: "banner banner-warn", attrs: { role: "status" } },
        h("p", { text: "The AI model wasn't available, so this is a basic reading of the posting." }),
        button("Analyze again", () => void startOver(), { disabled: false }),
      ),
    );
  }
  if (a.stale) out.push(h("div", { class: "banner banner-note" }, h("p", { text: "This page has changed since this analysis." })));
  out.push(fitCard(job));
  const groups = splitRequirements(a.requirements.filter((x) => !x.negated));
  const ranked = groups.required.length || groups.preferred.length;
  const sections = [
    reqSection("Must-haves", "req-required", groups.required),
    reqSection("Nice-to-haves", "req-preferred", groups.preferred),
    reqSection(ranked ? "Other requirements" : "Requirements", "req-unclear", groups.unclear, !ranked),
  ].filter((x): x is HTMLElement => x !== null);
  if (sections.length) out.push(...sections);
  else out.push(h("p", { class: "meta", text: "No requirements were found in this posting." }));
  out.push(nextSteps(job));
  out.push(trackDetails(job));
  out.push(aboutDetails(job));
  return out;
}

let lastScreen: Screen | null = null;

function render(): void {
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

// Popup + side panel UI (same app; layout adapts to the container).
// The UI never talks to the API: every action is a typed message to the service worker.

import { CONNECT_PAGE, WEB_BASE } from "../config";
import { MIN_TEXT, verdictFor, type ExtractResult } from "../shared/extract";
import {
  FIELD_LABEL,
  FIELD_ORDER,
  alternativesText,
  splitRequirements,
  type ApplicationView,
  type FieldName,
  type JobView,
  type LookupView,
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

const readPage = () =>
  run("Reading the page", async () => {
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

const submit = () =>
  run("Sending to Elevate", async () => {
    const d = v.draft;
    if (!d) return;
    const seq = v.seq;
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
  return h(
    "header",
    { class: "top" },
    h("div", { class: "brand" }, h("span", { class: "mark", attrs: { "aria-hidden": "true" }, text: "E" }), h("span", { class: "wordmark", text: "Elevate" })),
    signedIn
      ? h(
          "div",
          { class: "account" },
          h("span", { class: "email", text: v.state?.email ?? "", attrs: { title: v.state?.email ?? "" } }),
          !IS_PANEL ? button("Side panel", () => void openSidePanel(), { kind: "quiet", id: "btn-panel" }) : null,
          button("Sign out", () => void signOut(), { kind: "quiet", id: "btn-signout" }),
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

function renderMain(): HTMLElement[] {
  const out: HTMLElement[] = [heading("This page"), pageCard()];
  const a = v.access;
  if (a.kind !== "ok") {
    out.push(h("div", { class: "banner banner-note" }, h("p", { text: a.reason })));
    out.push(h("div", { class: "actions" }, button("Paste job text", startManual, { kind: "primary", id: "btn-manual" })));
  } else {
    if (v.lookup === undefined) out.push(h("p", { class: "meta", text: "Checking your jobs…" }));
    else if (v.lookup) {
      const l = v.lookup;
      out.push(
        h(
          "div",
          { class: "card existing" },
          h("p", { class: "eyebrow", text: l.saved ? "Already in your jobs · saved" : "Already in your jobs" }),
          h("p", { class: "page-title", text: [l.title, l.company].filter(Boolean).join(" · ") || "Untitled job" }),
          h(
            "div",
            { class: "row" },
            l.latestAnalysisId ? button("View analysis", () => viewExisting(l.id), { id: "btn-view-existing" }) : null,
            button("Open in dashboard", () => openTab(dashboardUrl(l.id)), { kind: "quiet" }),
          ),
        ),
      );
    }
    out.push(
      h(
        "div",
        { class: "actions" },
        button(v.lookup ? "Analyze again" : "Analyze this page", () => void readPage(), { kind: "primary", id: "btn-analyze" }),
        button("Paste text instead", startManual, { kind: "quiet", id: "btn-manual" }),
      ),
    );
    out.push(h("p", { class: "fine", text: "Elevate reads only this tab's visible text and job metadata, never form fields, passwords or cookies." }));
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

function fieldRow(name: FieldName, job: JobView): HTMLElement[] {
  const f = job.analysis?.fields[name];
  const value = f?.value ?? null;
  const notes: string[] = [];
  if (f?.source === "structured_data") notes.push("From page metadata (unverified)");
  if (f?.conflict) notes.push(`Page metadata says: ${f.conflict}`);
  return [
    h("dt", { text: FIELD_LABEL[name] }),
    h("dd", { class: value ? "" : "unknown" }, value ?? "Not stated", notes.length ? h("span", { class: "note", text: ` — ${notes.join("; ")}` }) : null),
  ];
}

function reqList(title: string, id: string, reqs: RequirementView[]): HTMLElement | null {
  if (!reqs.length) return null;
  return h(
    "section",
    { class: "reqs", attrs: { "aria-labelledby": id } },
    h("h2", { class: "section-h", id, text: `${title} (${reqs.length})` }),
    h(
      "ul",
      { class: "req-list" },
      reqs.map((r) => {
        const alt = alternativesText(r.alternatives);
        return h(
          "li",
          null,
          h("span", { class: "req-text", text: r.text }),
          alt ? h("span", { class: "req-alt", text: `Any of: ${alt}` }) : null,
          r.negated ? h("span", { class: "req-note", text: "Stated as not required" }) : null,
          r.notes.map((n) => h("span", { class: "req-note", text: n })),
        );
      }),
    ),
  );
}

function todayIso(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderActions(job: JobView): HTMLElement {
  const jobId = job.job.id;
  const status = v.application?.status ?? null;
  const noteArea = h("textarea", { id: "note-body", attrs: { rows: 3, maxlength: 20000 } });
  const remTitle = h("input", { id: "rem-title", type: "text", value: `Follow up: ${job.job.title ?? "job"}`.slice(0, 300), attrs: { maxlength: 300 } });
  const remDate = h("input", { id: "rem-date", type: "date", value: todayIso(), attrs: { min: todayIso(), required: true } });
  const remTime = h("input", { id: "rem-time", type: "time", value: "09:00", attrs: { required: true } });
  return h(
    "section",
    { class: "job-actions", attrs: { "aria-labelledby": "actions-h" } },
    h("h2", { class: "section-h", id: "actions-h", text: "Actions" }),
    h(
      "div",
      { class: "row wrap" },
      button(job.job.saved ? "Saved — remove" : "Save to my jobs", () => void toggleSave(), { pressed: job.job.saved, id: "btn-save" }),
      button("Open in dashboard", () => openTab(dashboardUrl(jobId)), { kind: "quiet", id: "btn-dashboard" }),
    ),
    h(
      "div",
      { class: "status-group", attrs: { role: "group", "aria-labelledby": "status-l" } },
      h("span", { id: "status-l", class: "meta", text: status && status !== "planned" && status !== "applied" ? `Application: ${status}` : "Application" }),
      button("Planned", () => void setStatus("planned"), { pressed: status === "planned", id: "btn-planned" }),
      button("Applied", () => void setStatus("applied"), { pressed: status === "applied", id: "btn-applied" }),
    ),
    h(
      "details",
      { class: "disclosure" },
      h("summary", { text: "Add a note" }),
      h("label", { for: "note-body", class: "sr-only", text: "Note" }),
      noteArea,
      button("Add note", () => {
        const body = noteArea.value.trim();
        if (!body) return;
        void addNote(body, () => (noteArea.value = ""));
      }),
    ),
    h(
      "details",
      { class: "disclosure" },
      h("summary", { text: "Add a reminder" }),
      h("div", { class: "field" }, h("label", { for: "rem-title", text: "Reminder" }), remTitle),
      h("div", { class: "row" }, h("div", { class: "field" }, h("label", { for: "rem-date", text: "Date" }), remDate), h("div", { class: "field" }, h("label", { for: "rem-time", text: "Time" }), remTime)),
      button("Add reminder", () => {
        if (!remTitle.value.trim() || !remDate.value || !remTime.value) {
          v.error = { code: "invalid", message: "Enter a reminder title, date and time.", requestId: null, retryable: false };
          render();
          return;
        }
        void addReminder(remTitle.value.trim(), remDate.value, remTime.value.slice(0, 5));
      }),
    ),
  );
}

function renderResult(): HTMLElement[] {
  const r = v.record;
  const out: HTMLElement[] = [];
  if (r && (r.state === "failed" || r.state === "timed-out")) {
    out.push(heading(stateLabel(r.state)));
    out.push(
      h(
        "div",
        { class: "banner banner-error", attrs: { role: "alert" } },
        h("p", { text: r.error?.message ?? "The analysis did not finish." }),
        r.error?.requestId ? h("p", { class: "meta" }, "Request ID: ", h("code", { text: r.error.requestId })) : null,
        r.error?.code ? h("p", { class: "meta", text: `Code: ${r.error.code}` }) : null,
      ),
    );
    out.push(
      h(
        "div",
        { class: "actions" },
        isRetryable(r.state) ? button("Retry", () => void retryCapture(), { kind: "primary", id: "btn-retry" }) : null,
        button("Start over", () => void startOver(), { kind: "quiet" }),
        button("Open in dashboard", () => openTab(dashboardUrl(r.jobId)), { kind: "quiet" }),
      ),
    );
    return out;
  }
  if (r && r.state === "cancelled") {
    out.push(heading("Cancelled"));
    out.push(h("p", { class: "prose", text: "The analysis was cancelled. The captured text is kept in your jobs." }));
    out.push(h("div", { class: "actions" }, button("Analyze again", () => void startOver(), { kind: "primary" }), button("Open in dashboard", () => openTab(dashboardUrl(r.jobId)), { kind: "quiet" })));
    return out;
  }

  const job = v.job;
  out.push(heading(r?.state === "partial-result" ? "Partial result" : "Analysis"));
  if (!job) {
    out.push(h("p", { class: "meta", text: v.error ? "The analysis could not be loaded." : "Loading the analysis…" }));
    if (v.error && v.resultJobId) out.push(button("Try again", () => void loadJob(v.resultJobId!, v.seq)));
    return out;
  }
  const a = job.analysis;
  if (r?.state === "partial-result" || a?.status === "partial") {
    out.push(h("div", { class: "banner banner-warn", attrs: { role: "status" } }, h("p", { text: "Only part of the analysis could be completed. Check the issues below and verify against the posting." })));
  }
  if (a?.stale) out.push(h("div", { class: "banner banner-note" }, h("p", { text: "A newer capture of this job exists; this analysis was made from an earlier version." })));

  out.push(h("dl", { class: "facts summary" }, ...fieldRow("title", job), ...fieldRow("company", job), ...fieldRow("location", job)));
  if (a) {
    const extra = FIELD_ORDER.filter((n) => !["title", "company", "location"].includes(n) && a.fields[n].value);
    if (extra.length) out.push(h("dl", { class: "facts" }, ...extra.flatMap((n) => fieldRow(n, job))));
    const groups = splitRequirements(a.requirements);
    const lists = [reqList("Required", "req-required", groups.required), reqList("Preferred", "req-preferred", groups.preferred), reqList("Importance not stated", "req-unclear", groups.unclear)].filter(
      (x): x is HTMLElement => x !== null,
    );
    if (lists.length) out.push(...lists);
    else out.push(h("p", { class: "meta", text: "No requirements were identified." }));
    if (a.issues.length) {
      out.push(
        h(
          "section",
          { class: "issues", attrs: { "aria-labelledby": "issues-h" } },
          h("h2", { class: "section-h", id: "issues-h", text: "Warnings" }),
          h(
            "ul",
            { class: "plain" },
            a.issues.map((i) => h("li", { text: i.message })),
          ),
        ),
      );
    }
    const modelBits = [a.model ? `Model ${a.model}` : null, a.promptVersion ? `prompt ${a.promptVersion}` : null, a.schemaVersion ? `schema ${a.schemaVersion}` : null].filter(Boolean);
    out.push(h("p", { class: "fine", text: modelBits.length ? modelBits.join(" · ") : "Model information unavailable" }));
    out.push(
      h(
        "p",
        { class: "fine" },
        `${job.historyCount} ${job.historyCount === 1 ? "analysis" : "analyses"} of this job. `,
        h("button", { type: "button", class: "link", text: "View history in the dashboard", on: { click: () => openTab(dashboardUrl(job.job.id)) } }),
      ),
    );
  } else {
    out.push(h("p", { class: "meta", text: "This job has no analysis yet." }));
  }
  out.push(renderActions(job));
  out.push(h("div", { class: "actions" }, button("Analyze this page again", () => void startOver(), { kind: "quiet" })));
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

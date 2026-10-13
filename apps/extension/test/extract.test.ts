// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { extractJobPage, validateExtraction, verdictFor, type ExtractOptions, type ExtractResult } from "../src/shared/extract";

const FIX = join(__dirname, "fixtures");
const OPTS: ExtractOptions = { attempts: 1, delayMs: 0, layout: false };

function load(name: string): void {
  const html = readFileSync(join(FIX, name), "utf8");
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.title = doc.title;
  document.head.replaceChildren(...Array.from(doc.head.childNodes).map((n) => document.importNode(n, true)));
  document.body.replaceChildren(...Array.from(doc.body.childNodes).map((n) => document.importNode(n, true)));
  window.getSelection()?.removeAllRanges();
}

/** Re-create the function from its source text, exactly as chrome.scripting serialises it. */
function serialised(): (o: ExtractOptions) => Promise<ExtractResult> {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${extractJobPage.toString()})`)() as (o: ExtractOptions) => Promise<ExtractResult>;
}

beforeEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe("extractJobPage", () => {
  it("is self-contained (works when rebuilt from its source text)", async () => {
    load("article-posting.html");
    const r = await serialised()(OPTS);
    expect(validateExtraction(r)).not.toBeNull();
    expect(r.text).toContain("Site Reliability Engineer");
  });

  it("stays self-contained after esbuild bundling + minification (release settings)", async () => {
    const { build } = await import("esbuild");
    const out = await build({
      entryPoints: [join(__dirname, "../src/shared/extract.ts")],
      bundle: true,
      write: false,
      format: "iife",
      globalName: "__extractModule",
      minify: true,
      target: ["chrome120"],
      platform: "browser",
    });
    const code = out.outputFiles[0]!.text;
    const mod = new Function(`${code}; return __extractModule;`)() as { extractJobPage: (o: ExtractOptions) => Promise<ExtractResult> };
    const rebuilt = new Function(`return (${mod.extractJobPage.toString()})`)() as (o: ExtractOptions) => Promise<ExtractResult>;
    load("jsonld-posting.html");
    const r = await rebuilt(OPTS);
    expect(r.adapter).toBe("jsonld");
    expect(validateExtraction(r)).not.toBeNull();
  });

  it("prefers a single JSON-LD JobPosting (in @graph) and strips HTML", async () => {
    load("jsonld-posting.html");
    const r = await extractJobPage(OPTS);
    expect(r.adapter).toBe("jsonld");
    expect(r.jsonLd).toEqual({ found: true, count: 1 });
    expect(r.title).toBe("Senior Data Engineer");
    expect(r.company).toBe("Fernhill Analytics");
    expect(r.location).toBe("Pune, MH, IN");
    expect(r.text).toContain("5+ years of experience in data engineering.");
    expect(r.text).toContain("- Strong SQL and Python or Scala.");
    expect(r.text).not.toMatch(/<[a-z]/i);
    expect(r.text).not.toContain("alert(");
    expect(r.structured).not.toBeNull();
    // Only whitelisted keys are forwarded.
    expect(JSON.stringify(r.structured)).not.toContain("applicantSecretField");
    expect(JSON.stringify(r.structured)).not.toContain("sameAs");
    expect((r.structured as Record<string, unknown>).employmentType).toEqual(["FULL_TIME"]);
    expect(verdictFor(r)).toEqual({ kind: "ok" });
    expect(validateExtraction(r)).toEqual(r);
  });

  it("flags listing pages with several JobPostings as multiple-jobs and sends no structured data", async () => {
    load("listing-two-postings.html");
    const r = await extractJobPage(OPTS);
    expect(r.jsonLd).toEqual({ found: true, count: 2 });
    expect(r.structured).toBeNull();
    expect(verdictFor(r)).toEqual({ kind: "multiple", count: 2 });
  });

  it("offers the user's selection (> 200 chars) so one job can be picked from a listing", async () => {
    load("listing-two-postings.html");
    const card = document.getElementById("job-designer")!;
    const range = document.createRange();
    range.selectNodeContents(card);
    window.getSelection()!.addRange(range);
    const r = await extractJobPage(OPTS);
    expect(r.selection).not.toBeNull();
    expect(r.selection!).toContain("Product Designer");
    expect(r.selection!).not.toContain("Frontend Engineer");
  });

  it("ignores short selections", async () => {
    load("article-posting.html");
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("h1")!);
    window.getSelection()!.addRange(range);
    const r = await extractJobPage(OPTS);
    expect(r.selection).toBeNull();
  });

  it("falls back to the largest readable block and excludes nav/header/aside/footer", async () => {
    load("article-posting.html");
    const r = await extractJobPage(OPTS);
    expect(r.adapter).toBe("generic");
    expect(r.jsonLd.found).toBe(false);
    expect(r.structured).toBeNull();
    expect(r.title).toBe("We're hiring: Site Reliability Engineer");
    expect(r.text).toContain("- 3+ years operating production Linux systems.");
    expect(r.text).toContain("Bonus: experience with Prometheus and Grafana.");
    expect(r.text).not.toContain("Popular posts");
    expect(r.text).not.toContain("Subscribe to our newsletter");
    expect(r.text).not.toContain("Blog");
  });

  it("never captures form values, password/hidden fields, hidden or editable content", async () => {
    load("sensitive-form.html");
    // Even a selection that spans the form must not leak field contents.
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("main")!);
    window.getSelection()!.addRange(range);
    const r = await extractJobPage(OPTS);
    const all = JSON.stringify(r);
    expect(r.text).toContain("4+ years building backend services in Java or Kotlin.");
    for (const secret of [
      "PASSWORD-SECRET",
      "CSRF-TOKEN-SECRET",
      "COVER-LETTER-SECRET",
      "OPTION-SECRET",
      "candidate@example.test",
      "HIDDEN-STYLE-SECRET",
      "HIDDEN-ATTR-SECRET",
      "ARIA-HIDDEN-SECRET",
      "EDITABLE-SECRET",
    ]) {
      expect(r.text).not.toContain(secret);
      // selection text comes from the browser's own Selection serialisation; it may include visible
      // labels but must never include input/textarea/select values.
      if (/PASSWORD|CSRF|COVER|candidate/.test(secret)) expect(all).not.toContain(secret);
    }
  });

  it("matches site adapters by host (LinkedIn-like markup, adapter unverified live)", async () => {
    document.title = "Job | LinkedIn";
    document.body.innerHTML = `
      <header>global nav</header>
      <div class="job-details-jobs-unified-top-card__job-title"><h1>Platform Engineer</h1></div>
      <div class="job-details-jobs-unified-top-card__company-name"><a>Halden Robotics</a></div>
      <div class="jobs-description__content"><div id="job-details"><p>${"Halden Robotics (fictional) builds warehouse robots. ".repeat(4)}</p>
      <ul><li>Required: 4+ years with Kubernetes.</li><li>Preferred: Rust or C++.</li></ul></div></div>`;
    const r = await extractJobPage({ ...OPTS, host: "www.linkedin.com" });
    expect(r.adapter).toBe("linkedin");
    expect(r.title).toBe("Platform Engineer");
    expect(r.company).toBe("Halden Robotics");
    expect(r.text).toContain("Required: 4+ years with Kubernetes.");
  });

  it("reports insufficient text and retries the requested number of times", async () => {
    document.body.innerHTML = "<main><p>Loading…</p></main>";
    const r = await extractJobPage({ attempts: 3, delayMs: 1, layout: false });
    expect(r.attempts).toBe(3);
    expect(verdictFor(r)).toEqual({ kind: "insufficient" });
  });

  it("picks up content that appears while retrying (SPA)", async () => {
    document.body.innerHTML = "<main id='m'><p>Loading…</p></main>";
    setTimeout(() => {
      document.getElementById("m")!.innerHTML = `<p>${"A fictional job description sentence with enough words. ".repeat(6)}</p>`;
    }, 5);
    const r = await extractJobPage({ attempts: 3, delayMs: 20, layout: false });
    expect(r.attempts).toBeGreaterThan(1);
    expect(verdictFor(r)).toEqual({ kind: "ok" });
  });

  it("bounds text to 60,000 characters", async () => {
    document.body.innerHTML = `<main><p>${"x".repeat(70_000)}</p></main>`;
    const r = await extractJobPage(OPTS);
    expect(r.text.length).toBe(60_000);
    expect(r.truncated).toBe(true);
    expect(validateExtraction(r)).not.toBeNull();
  });
});

describe("validateExtraction", () => {
  const base = (): Record<string, unknown> => ({
    v: 1,
    href: "https://careers.example.test/jobs/1",
    pageTitle: "Job",
    readyState: "complete",
    capturedAt: new Date().toISOString(),
    adapter: "generic",
    jsonLd: { found: false, count: 0 },
    structured: null,
    title: null,
    company: null,
    location: null,
    text: "x".repeat(300),
    textLength: 300,
    truncated: false,
    selection: null,
    attempts: 1,
  });

  it("accepts a well-formed result", () => {
    expect(validateExtraction(base())).not.toBeNull();
  });

  it.each([
    ["non-object", null],
    ["wrong version", { ...base(), v: 2 }],
    ["oversized text", { ...base(), text: "x".repeat(60_001) }],
    ["oversized title", { ...base(), title: "t".repeat(301) }],
    ["bad adapter", { ...base(), adapter: "<script>" }],
    ["array structured", { ...base(), structured: [] }],
    ["huge structured", { ...base(), structured: { d: "x".repeat(60_000) } }],
    ["bad attempts", { ...base(), attempts: 9 }],
    ["bad date", { ...base(), capturedAt: "yesterday" }],
  ])("rejects %s", (_n, value) => {
    expect(validateExtraction(value)).toBeNull();
  });
});

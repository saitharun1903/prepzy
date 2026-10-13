// Page extraction.
//
// `extractJobPage` is injected with chrome.scripting.executeScript({ func }) into the active tab
// (frame 0) only after the user clicks. It MUST be self-contained: Chrome serialises the function
// source, so it may not reference anything outside its own body (imports, module constants,
// helpers). A unit test re-creates it from its source text to enforce this.
//
// Privacy rules enforced here: never read input/textarea/select values, password or hidden fields,
// cookies, localStorage/sessionStorage, or form contents. Only visible text and JSON-LD JobPosting
// data (treated as untrusted claims) are returned.

export interface ExtractOptions {
  attempts: number;
  delayMs: number;
  /** use layout-based visibility checks (true in a real browser; false in DOM test environments) */
  layout: boolean;
  /** test-only override of location.hostname for site-adapter matching */
  host?: string;
}

export interface ExtractResult {
  v: 1;
  href: string;
  pageTitle: string;
  readyState: string;
  capturedAt: string;
  adapter: string;
  jsonLd: { found: boolean; count: number };
  structured: Record<string, unknown> | null;
  title: string | null;
  company: string | null;
  location: string | null;
  text: string;
  textLength: number;
  truncated: boolean;
  selection: string | null;
  attempts: number;
}

export const MAX_TEXT = 60_000;
export const MIN_TEXT = 200;
export const MAX_STRUCTURED_JSON = 50_000;

export async function extractJobPage(opts: ExtractOptions): Promise<ExtractResult> {
  const MAX = 60000;
  const MIN = 200;
  const attempts = Math.min(Math.max(Number(opts && opts.attempts) || 1, 1), 3);
  const delayMs = Math.min(Math.max(Number(opts && opts.delayMs) || 0, 0), 2000);
  const layout = !!(opts && opts.layout);
  const host = String((opts && opts.host) || location.hostname || "").toLowerCase();

  const SKIP = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "IFRAME", "OBJECT", "EMBED", "CANVAS", "VIDEO", "AUDIO",
    "NAV", "HEADER", "FOOTER", "ASIDE", "FORM", "INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON", "LABEL",
    "DATALIST", "OUTPUT", "METER", "PROGRESS", "MAP", "HEAD", "LINK", "META",
  ]);
  const BLOCK = new Set([
    "P", "DIV", "SECTION", "ARTICLE", "MAIN", "UL", "OL", "DL", "DT", "DD", "TABLE", "TR", "H1", "H2", "H3", "H4",
    "H5", "H6", "PRE", "BLOCKQUOTE", "FIGURE", "FIGCAPTION", "DETAILS", "SUMMARY", "ADDRESS", "HR",
  ]);
  const BANNER = /(cookie|consent|gdpr|onetrust|cookiebot|truste|privacy-banner)/i;

  const clean = (t: string): string =>
    t
      .replace(/[ \t\f\v ​]+/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const one = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null;
    const t = v.replace(/\s+/g, " ").trim();
    return t ? t.slice(0, max) : null;
  };

  const isHidden = (el: Element): boolean => {
    if ((el as HTMLElement).hidden) return true;
    if (el.getAttribute("aria-hidden") === "true") return true;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "hidden" || type === "password") return true;
    const st = (el as HTMLElement).style;
    if (st && (st.display === "none" || st.visibility === "hidden")) return true;
    const idc = (el.id || "") + " " + (typeof el.className === "string" ? el.className : "");
    if (idc.length > 1 && BANNER.test(idc)) return true;
    if (layout) {
      const anyEl = el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean };
      if (typeof anyEl.checkVisibility === "function") {
        if (!anyEl.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: false })) return true;
      } else {
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") return true;
      }
    }
    return false;
  };

  const textOf = (root: Element | null, range?: Range): string => {
    if (!root) return "";
    const out: string[] = [];
    let len = 0;
    const walk = (node: Node): void => {
      if (len > MAX + 2000) return;
      if (range && !range.intersectsNode(node)) return;
      if (node.nodeType === 3) {
        let v = node.nodeValue || "";
        if (range) {
          if (node === range.endContainer) v = v.slice(0, range.endOffset);
          if (node === range.startContainer) v = v.slice(range.startOffset);
        }
        if (v) {
          out.push(v.replace(/\s+/g, " "));
          len += v.length;
        }
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node as Element;
      const tag = el.tagName.toUpperCase();
      if (SKIP.has(tag) || isHidden(el)) return;
      if ((el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null) return;
      if (tag === "BR") {
        out.push("\n");
        return;
      }
      if (tag === "LI") out.push("\n- ");
      else if (tag === "TD" || tag === "TH") out.push(" ");
      else if (BLOCK.has(tag)) out.push("\n");
      for (let c = el.firstChild; c; c = c.nextSibling) walk(c);
      if (BLOCK.has(tag) || tag === "LI") out.push("\n");
    };
    walk(root);
    return clean(out.join(""));
  };

  const stripHtml = (html: string): string => {
    const pre = html
      .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<\s*br\s*\/?>/gi, "\n")
      .replace(/<\s*li[^>]*>/gi, "\n- ")
      .replace(/<\/\s*(p|div|li|ul|ol|h[1-6]|tr|section)\s*>/gi, "\n");
    try {
      // DOMParser documents are inert: no scripts run and no resources load.
      const doc = new DOMParser().parseFromString(pre, "text/html");
      for (const el of Array.from(doc.querySelectorAll("script, style, noscript, template"))) el.remove();
      return clean(doc.body ? doc.body.textContent || "" : "");
    } catch {
      return clean(pre.replace(/<[^>]*>/g, " "));
    }
  };

  // ---- JSON-LD JobPosting (untrusted claims) ----
  const isPosting = (n: unknown): boolean => {
    if (!n || typeof n !== "object") return false;
    const t = (n as Record<string, unknown>)["@type"];
    if (typeof t === "string") return t === "JobPosting" || t.endsWith("/JobPosting");
    if (Array.isArray(t)) return t.some((x) => x === "JobPosting");
    return false;
  };
  const postings: Record<string, unknown>[] = [];
  const visit = (n: unknown, depth: number): void => {
    if (depth > 4 || !n || typeof n !== "object") return;
    if (Array.isArray(n)) {
      for (const x of n.slice(0, 50)) visit(x, depth + 1);
      return;
    }
    const o = n as Record<string, unknown>;
    if (isPosting(o)) {
      postings.push(o);
      return;
    }
    if (Array.isArray(o["@graph"])) visit(o["@graph"], depth + 1);
    if (o.mainEntity && typeof o.mainEntity === "object") visit(o.mainEntity, depth + 1);
    if (Array.isArray(o.itemListElement)) {
      for (const it of (o.itemListElement as unknown[]).slice(0, 50)) {
        if (it && typeof it === "object" && (it as Record<string, unknown>).item) visit((it as Record<string, unknown>).item, depth + 1);
        else visit(it, depth + 1);
      }
    }
  };
  const ldScripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).slice(0, 30);
  for (const sc of ldScripts) {
    const raw = sc.textContent || "";
    if (!raw || raw.length > 400000) continue;
    try {
      visit(JSON.parse(raw), 0);
    } catch {
      /* malformed JSON-LD is ignored */
    }
  }

  const name = (v: unknown, max: number): string | null => {
    if (typeof v === "string") return one(v, max);
    if (v && typeof v === "object" && !Array.isArray(v)) return one((v as Record<string, unknown>).name, max);
    if (Array.isArray(v) && v.length) return name(v[0], max);
    return null;
  };
  const numOrStr = (v: unknown): number | string | null =>
    typeof v === "number" && isFinite(v) ? v : typeof v === "string" ? v.slice(0, 40) : null;

  const sanitizePosting = (p: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = { "@type": "JobPosting" };
    const title = one(p.title, 300);
    if (title) out.title = title;
    if (typeof p.description === "string") out.description = stripHtml(p.description.slice(0, 120000)).slice(0, 20000);
    const org = name(p.hiringOrganization, 300);
    if (org) out.hiringOrganization = { name: org };
    const locs = (Array.isArray(p.jobLocation) ? p.jobLocation : p.jobLocation ? [p.jobLocation] : []).slice(0, 5);
    const cleanLocs: Record<string, unknown>[] = [];
    for (const l of locs) {
      if (!l || typeof l !== "object") continue;
      const a = (l as Record<string, unknown>).address;
      if (a && typeof a === "object") {
        const ad = a as Record<string, unknown>;
        const addr: Record<string, string> = {};
        for (const k of ["addressLocality", "addressRegion", "addressCountry", "postalCode"]) {
          const v = name(ad[k], 120);
          if (v) addr[k] = v;
        }
        cleanLocs.push({ address: addr });
      } else {
        const nm = name(l, 200);
        if (nm) cleanLocs.push({ name: nm });
      }
    }
    if (cleanLocs.length) out.jobLocation = cleanLocs;
    const jlt = name(p.jobLocationType, 40);
    if (jlt) out.jobLocationType = jlt;
    if (Array.isArray(p.employmentType)) {
      const et = p.employmentType.map((x) => one(x, 40)).filter((x): x is string => !!x).slice(0, 10);
      if (et.length) out.employmentType = et;
    } else {
      const et = one(p.employmentType, 80);
      if (et) out.employmentType = et;
    }
    for (const k of ["datePosted", "validThrough"]) {
      const v = one(p[k], 40);
      if (v) out[k] = v;
    }
    const sal = p.baseSalary;
    if (sal && typeof sal === "object" && !Array.isArray(sal)) {
      const so = sal as Record<string, unknown>;
      const val = so.value && typeof so.value === "object" ? (so.value as Record<string, unknown>) : {};
      out.baseSalary = {
        currency: one(so.currency, 10),
        value: {
          minValue: numOrStr(val.minValue),
          maxValue: numOrStr(val.maxValue),
          value: numOrStr(val.value),
          unitText: one(val.unitText, 20),
        },
      };
    }
    return out;
  };

  const locationOf = (s: Record<string, unknown> | null): string | null => {
    if (!s) return null;
    if (s.jobLocationType === "TELECOMMUTE") return "Remote";
    const locs = s.jobLocation as Record<string, unknown>[] | undefined;
    const first = locs && locs[0];
    if (!first) return null;
    const a = first.address as Record<string, string> | undefined;
    if (a) {
      const parts = [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean);
      return parts.length ? parts.join(", ").slice(0, 200) : null;
    }
    return one(first.name, 200);
  };

  // ---- site adapters (best effort; selectors unverified until live-tested) ----
  const ADAPTERS: { id: string; host: RegExp; body: string[]; title: string[]; company: string[]; location: string[] }[] = [
    {
      id: "linkedin",
      host: /(^|\.)linkedin\.com$/,
      body: [".jobs-description__content", ".jobs-description", ".jobs-box__html-content", "#job-details"],
      title: [".job-details-jobs-unified-top-card__job-title", ".jobs-unified-top-card__job-title", ".top-card-layout__title", "h1"],
      company: [".job-details-jobs-unified-top-card__company-name", ".jobs-unified-top-card__company-name", ".topcard__org-name-link"],
      location: [".job-details-jobs-unified-top-card__primary-description-container .tvm__text", ".jobs-unified-top-card__bullet", ".topcard__flavor--bullet"],
    },
    {
      id: "indeed",
      host: /(^|\.)indeed\.[a-z.]+$/,
      body: ["#jobDescriptionText"],
      title: ['[data-testid="jobsearch-JobInfoHeader-title"]', ".jobsearch-JobInfoHeader-title", "h1"],
      company: ['[data-testid="inlineHeader-companyName"]', '[data-company-name="true"]'],
      location: ['[data-testid="inlineHeader-companyLocation"]', '[data-testid="job-location"]'],
    },
    {
      id: "naukri",
      host: /(^|\.)naukri\.com$/,
      body: ['[class*="styles_JDC__dang-inner-html"]', ".styles_JDC__dang-inner-html", ".job-desc", ".dang-inner-html"],
      title: ['[class*="styles_jd-header-title"]', ".jd-header-title", "h1"],
      company: ['[class*="styles_jd-header-comp-name"] a', ".jd-header-comp-name a"],
      location: ['[class*="styles_jhc__location"]', ".location"],
    },
    {
      id: "greenhouse",
      host: /(^|\.)greenhouse\.io$/,
      body: [".job__description", "#content"],
      title: [".job__title h1", ".app-title", "h1"],
      company: [".company-name"],
      location: [".job__location", ".location"],
    },
    {
      id: "lever",
      host: /(^|\.)lever\.co$/,
      body: [".posting-page", '[data-qa="job-description"]'],
      title: [".posting-headline h2", "h2"],
      company: [],
      location: [".posting-categories .location", ".location"],
    },
  ];

  const firstText = (sels: string[], max: number): string | null => {
    for (const sel of sels) {
      let el: Element | null = null;
      try {
        el = document.querySelector(sel);
      } catch {
        el = null;
      }
      if (el && !isHidden(el)) {
        const t = one(textOf(el), max);
        if (t) return t;
      }
    }
    return null;
  };

  // ---- generic readable-text fallback ----
  const genericRoot = (): Element | null => {
    for (const sel of ["main", "article", '[role="main"]']) {
      const el = document.querySelector(sel);
      if (el && textOf(el).length >= MIN) return el;
    }
    // Largest text block: score containers by the paragraph/list text directly inside them.
    const scores = new Map<Element, number>();
    const nodes = Array.from(document.querySelectorAll("p, li, pre, td, h2, h3")).slice(0, 4000);
    for (const n of nodes) {
      let skip = false;
      for (let a: Element | null = n; a; a = a.parentElement) {
        if (SKIP.has(a.tagName.toUpperCase()) || isHidden(a)) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      const len = (n.textContent || "").trim().length;
      if (len < 20) continue;
      const p1 = n.parentElement;
      const p2 = p1 && p1.parentElement;
      if (p1) scores.set(p1, (scores.get(p1) || 0) + len);
      if (p2) scores.set(p2, (scores.get(p2) || 0) + len / 2);
    }
    let best: Element | null = null;
    let bestScore = 0;
    for (const [k, v] of scores) {
      if (v > bestScore && k !== document.documentElement) {
        best = k;
        bestScore = v;
      }
    }
    return best || document.body;
  };

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  const count = postings.length;
  const structured = count === 1 && postings[0] ? sanitizePosting(postings[0]) : null;

  let adapter = "none";
  let text = "";
  let title: string | null = null;
  let company: string | null = null;
  let loc: string | null = null;
  let tries = 0;
  const site = ADAPTERS.find((a) => a.host.test(host)) || null;

  for (let i = 0; i < attempts; i++) {
    tries = i + 1;
    adapter = "none";
    text = "";
    const desc = structured && typeof structured.description === "string" ? structured.description : "";
    if (desc.length >= MIN) {
      text = desc;
      adapter = "jsonld";
    }
    if (!text && site) {
      for (const sel of site.body) {
        let el: Element | null = null;
        try {
          el = document.querySelector(sel);
        } catch {
          el = null;
        }
        if (!el || isHidden(el)) continue;
        const t = textOf(el);
        if (t.length >= MIN) {
          text = t;
          adapter = site.id;
          break;
        }
      }
    }
    if (!text) {
      const t = textOf(genericRoot());
      if (t.length >= MIN) {
        text = t;
        adapter = "generic";
      } else {
        text = t;
      }
    }
    if (text.length >= MIN) break;
    if (i < attempts - 1) await sleep(delayMs);
  }

  title = (structured && one(structured.title, 300)) || (site && firstText(site.title, 300)) || firstText(["h1"], 300);
  const org = structured && structured.hiringOrganization && typeof structured.hiringOrganization === "object"
    ? one((structured.hiringOrganization as Record<string, unknown>).name, 300)
    : null;
  company = org || (site && firstText(site.company, 300)) || null;
  loc = locationOf(structured) || (site && firstText(site.location, 200)) || null;

  // ---- user selection (lets the user pick one job on a listing page) ----
  let selection: string | null = null;
  try {
    const ae = document.activeElement;
    const inField = !!ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName.toUpperCase());
    const sel = window.getSelection ? window.getSelection() : null;
    if (sel && !inField && sel.rangeCount > 0) {
      // Serialise the selection with the same walker as page text (skips form fields, hidden and
      // editable content) instead of Selection.toString().
      const parts: string[] = [];
      for (let i = 0; i < Math.min(sel.rangeCount, 5); i++) {
        const range = sel.getRangeAt(i);
        const c = range.commonAncestorContainer;
        const el = c.nodeType === 1 ? (c as Element) : c.parentElement;
        let blocked = false;
        for (let a: Element | null = el; a; a = a.parentElement) {
          if (SKIP.has(a.tagName.toUpperCase()) || isHidden(a) || a.getAttribute("contenteditable") !== null) {
            blocked = true;
            break;
          }
        }
        if (!blocked && el) parts.push(textOf(el, range));
      }
      const st = clean(parts.join("\n\n"));
      if (st.length > MIN) selection = st.slice(0, MAX);
    }
  } catch {
    selection = null;
  }

  const full = text.length;
  return {
    v: 1,
    href: String(location.href).slice(0, 4000),
    pageTitle: String(document.title || "").slice(0, 500),
    readyState: String(document.readyState),
    capturedAt: new Date().toISOString(),
    adapter,
    jsonLd: { found: count > 0, count },
    structured,
    title,
    company,
    location: loc,
    text: text.slice(0, MAX),
    textLength: Math.min(full, MAX),
    truncated: full > MAX,
    selection,
    attempts: tries,
  };
}

// ---------------------------------------------------------------- validation (service worker side)

const isStrOrNull = (v: unknown, max: number): v is string | null => v === null || (typeof v === "string" && v.length <= max);

/** Validate an executeScript result (shape + sizes) before it is used or stored. */
export function validateExtraction(x: unknown): ExtractResult | null {
  if (!x || typeof x !== "object" || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  if (r.v !== 1) return null;
  if (typeof r.href !== "string" || r.href.length > 4000) return null;
  if (typeof r.pageTitle !== "string" || r.pageTitle.length > 500) return null;
  if (typeof r.readyState !== "string" || r.readyState.length > 20) return null;
  if (typeof r.capturedAt !== "string" || r.capturedAt.length > 40 || Number.isNaN(Date.parse(r.capturedAt))) return null;
  if (typeof r.adapter !== "string" || !/^[a-z]{2,20}$/.test(r.adapter)) return null;
  const jl = r.jsonLd as Record<string, unknown> | null;
  if (!jl || typeof jl !== "object" || typeof jl.found !== "boolean" || typeof jl.count !== "number" || jl.count < 0 || jl.count > 1000) return null;
  if (r.structured !== null) {
    if (typeof r.structured !== "object" || Array.isArray(r.structured)) return null;
    let size = 0;
    try {
      size = JSON.stringify(r.structured).length;
    } catch {
      return null;
    }
    if (size > MAX_STRUCTURED_JSON) return null;
  }
  if (!isStrOrNull(r.title, 300) || !isStrOrNull(r.company, 300) || !isStrOrNull(r.location, 200)) return null;
  if (typeof r.text !== "string" || r.text.length > MAX_TEXT) return null;
  if (typeof r.textLength !== "number" || r.textLength < 0 || r.textLength > MAX_TEXT) return null;
  if (typeof r.truncated !== "boolean") return null;
  if (!isStrOrNull(r.selection, MAX_TEXT)) return null;
  if (typeof r.attempts !== "number" || r.attempts < 1 || r.attempts > 3) return null;
  return {
    v: 1,
    href: r.href,
    pageTitle: r.pageTitle,
    readyState: r.readyState,
    capturedAt: r.capturedAt,
    adapter: r.adapter,
    jsonLd: { found: jl.found, count: jl.count },
    structured: (r.structured as Record<string, unknown> | null) ?? null,
    title: r.title as string | null,
    company: r.company as string | null,
    location: r.location as string | null,
    text: r.text,
    textLength: r.textLength,
    truncated: r.truncated,
    selection: r.selection as string | null,
    attempts: r.attempts,
  };
}

export type ExtractionVerdict =
  | { kind: "ok" }
  | { kind: "multiple"; count: number }
  | { kind: "insufficient" };

/** What the preview should allow for this extraction. */
export function verdictFor(r: ExtractResult): ExtractionVerdict {
  if (r.jsonLd.count > 1) return { kind: "multiple", count: r.jsonLd.count };
  if (r.text.length < MIN_TEXT) return { kind: "insufficient" };
  return { kind: "ok" };
}

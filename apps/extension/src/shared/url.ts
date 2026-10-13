// URL helpers shared by the service worker and the UI. Pure functions (unit-tested).

const TRACKING_PARAM = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|igshid)$/i;

/**
 * Normalise a page URL for "is this the same page?" comparisons:
 * lower-case scheme/host, drop default ports, the fragment and common tracking parameters,
 * sort the remaining query parameters. Returns null for non-http(s) or unparsable URLs.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4000) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  const keep: [string, string][] = [];
  u.searchParams.forEach((v, k) => {
    if (!TRACKING_PARAM.test(k)) keep.push([k, v]);
  });
  keep.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  const qs = new URLSearchParams(keep).toString();
  let path = u.pathname || "/";
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${u.protocol}//${u.host.toLowerCase()}${path}${qs ? `?${qs}` : ""}`;
}

export function sameUrl(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeUrl(a);
  return na !== null && na === normalizeUrl(b);
}

export type PageAccess =
  | { kind: "ok" }
  | { kind: "restricted"; reason: string }
  | { kind: "pdf"; reason: string }
  | { kind: "unknown"; reason: string };

const STORE_HOSTS = ["chromewebstore.google.com", "microsoftedge.microsoft.com"];

/** Decide up-front whether the extension can read a tab's page. */
export function classifyUrl(raw: string | null | undefined): PageAccess {
  if (typeof raw !== "string" || raw.length === 0) {
    return {
      kind: "unknown",
      reason: "Elevate can only read a page after you click the Elevate toolbar button while that page is open.",
    };
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: "restricted", reason: "This address cannot be read." };
  }
  const browserPage = ["chrome:", "edge:", "about:", "chrome-extension:", "extension:", "devtools:", "view-source:", "chrome-search:", "chrome-untrusted:"];
  if (browserPage.includes(u.protocol)) {
    return { kind: "restricted", reason: "Browser pages (settings, new tab, extensions) cannot be read by extensions." };
  }
  if (u.protocol === "file:") {
    return { kind: "restricted", reason: "Local files cannot be read. Paste the job text instead." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { kind: "restricted", reason: "Only web pages (http/https) can be read." };
  }
  const host = u.hostname.toLowerCase();
  if (STORE_HOSTS.includes(host) || (host === "chrome.google.com" && u.pathname.startsWith("/webstore"))) {
    return { kind: "restricted", reason: "Extension stores cannot be read by extensions." };
  }
  if (/\.pdf$/i.test(u.pathname)) {
    return { kind: "pdf", reason: "PDF documents open in the browser's PDF viewer, which extensions cannot read. Copy the text and paste it instead." };
  }
  return { kind: "ok" };
}

export function hostOf(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    return new URL(raw).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID.test(v);
}

/** Build a dashboard URL for a job. Never carries tokens; the id must be a UUID. */
export function dashboardJobUrl(webBase: string, jobId: string): string | null {
  if (!isUuid(jobId)) return null;
  return `${webBase.replace(/\/+$/, "")}/jobs/${encodeURIComponent(jobId)}`;
}

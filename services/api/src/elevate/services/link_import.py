"""Import a job posting from a link (LinkedIn, Naukri, Indeed, company career sites, ATS pages).

Security (the server fetches a user-supplied URL, so SSRF is the main risk):
  * http(s) only, default ports only, no credentials in the URL;
  * every hostname is resolved and must map ONLY to public (global) IP addresses — loopback, private,
    link-local, metadata (169.254.169.254), CGNAT, multicast and reserved ranges are refused;
  * redirects are followed manually (max 4) and every hop is re-validated;
  * 12 s total timeout, 3 MB response cap, HTML/JSON content types only; no cookies are sent or kept.

Extraction order: LinkedIn guest job API -> schema.org JobPosting JSON-LD -> readable page text.
"""

from __future__ import annotations

import html
import ipaddress
import json
import re
import socket
import time
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx

from ..errors import ValidationFailed

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/131.0.0.0 Safari/537.36")
MAX_BYTES = 3 * 1024 * 1024
TIMEOUT = 12.0
MAX_REDIRECTS = 4


@dataclass
class Imported:
    url: str
    text: str
    title: str | None
    company: str | None
    location: str | None
    source: str  # "linkedin" | "jsonld" | "page"


class LinkError(ValidationFailed):
    def __init__(self, message: str, code: str = "link_unreadable") -> None:
        super().__init__(message, code=code)


# ------------------------------------------------------------------ URL safety
def _public_host(host: str) -> None:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except socket.gaierror as e:
        raise LinkError("That website could not be found. Check the link.", "link_dns") from e
    if not infos:
        raise LinkError("That website could not be found. Check the link.", "link_dns")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            raise LinkError("This link points to a private or internal address, which isn't allowed.", "link_blocked")


def check_url(url: str) -> str:
    url = (url or "").strip()
    if len(url) > 2000:
        raise LinkError("That link is too long.", "link_invalid")
    if re.match(r"^[a-z][a-z0-9+.-]*:", url, re.IGNORECASE) and not re.match(r"^https?://", url, re.IGNORECASE):
        raise LinkError("Only http(s) job links are supported.", "link_invalid")
    if not re.match(r"^https?://", url, re.IGNORECASE):
        url = "https://" + url
    try:
        p = urlsplit(url)
    except ValueError as e:
        raise LinkError("That doesn't look like a web link.", "link_invalid") from e
    if p.scheme.lower() not in ("http", "https") or not p.hostname:
        raise LinkError("Only http(s) job links are supported.", "link_invalid")
    if p.username or p.password:
        raise LinkError("Links with a username or password aren't allowed.", "link_invalid")
    if p.port not in (None, 80, 443):
        raise LinkError("Only standard web ports are allowed.", "link_invalid")
    host = p.hostname.lower().rstrip(".")
    if host in ("localhost",) or host.endswith((".local", ".internal", ".localhost")):
        raise LinkError("This link points to a private or internal address, which isn't allowed.", "link_blocked")
    return url


def _fetch(url: str, accept: str = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5") -> tuple[str, str]:
    """GET with manual, re-validated redirects. Returns (final_url, body_text)."""
    current = check_url(url)
    with httpx.Client(timeout=httpx.Timeout(TIMEOUT, connect=6.0), follow_redirects=False,
                      headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"}) as c:
        for _ in range(MAX_REDIRECTS + 1):
            _public_host(urlsplit(current).hostname or "")
            try:
                with c.stream("GET", current) as r:
                    if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                        current = check_url(urljoin(current, r.headers["location"]))
                        continue
                    if r.status_code in (401, 403, 429, 999):
                        raise LinkError("That site blocked automatic reading (it needs you to be signed in). "
                                        "Open the job and use the Prepzy extension, or paste the text instead.",
                                        "link_blocked_by_site")
                    if r.status_code == 404 or r.status_code == 410:
                        raise LinkError("That job page wasn't found — it may have been removed.", "link_not_found")
                    if r.status_code >= 400:
                        raise LinkError(f"The site returned an error ({r.status_code}). Try again or paste the text.")
                    ctype = r.headers.get("content-type", "").lower()
                    if ctype and not any(t in ctype for t in ("html", "json", "xml", "text/plain")):
                        raise LinkError("That link isn't a web page (it may be a file or image).", "link_invalid")
                    buf = bytearray()
                    for chunk in r.iter_bytes():
                        buf.extend(chunk)
                        if len(buf) > MAX_BYTES:
                            break
                    enc = r.encoding or "utf-8"
                    return current, bytes(buf).decode(enc, errors="replace")
            except httpx.TimeoutException as e:
                raise LinkError("The site took too long to respond. Try again or paste the text.", "link_timeout") from e
            except httpx.HTTPError as e:
                raise LinkError("Couldn't connect to that site. Check the link or paste the text.", "link_unreachable") from e
    raise LinkError("That link redirects too many times.", "link_invalid")


# ------------------------------------------------------------------ HTML helpers
_BLOCK = {"p", "div", "br", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "header",
          "footer", "table", "dd", "dt", "blockquote", "pre"}
_SKIP = {"script", "style", "noscript", "template", "svg", "iframe", "head", "nav", "form", "button", "select"}


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _SKIP:
            self.skip += 1
        elif tag == "li":
            self.parts.append("\n- ")
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)


def html_to_text(fragment: str) -> str:
    p = _Text()
    p.feed(fragment)
    text = "".join(p.parts)
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r" *\n *", "\n", text)
    text = re.sub(r"\n-\s*\n", "\n", text)
    text = re.sub(r"\n{2,}- ", "\n- ", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _between(doc: str, cls: str) -> str | None:
    """Inner HTML of the first element whose class list contains `cls` (balanced on the same tag name)."""
    m = re.search(r"<(\w+)[^>]*class=\"[^\"]*\b" + re.escape(cls) + r"\b[^\"]*\"[^>]*>", doc)
    if not m:
        return None
    tag, start, depth, i = m.group(1), m.end(), 1, m.end()
    pat = re.compile(r"<(/?)" + tag + r"\b[^>]*>", re.IGNORECASE)
    while depth and (n := pat.search(doc, i)):
        depth += -1 if n.group(1) else 1
        i = n.end()
        if depth == 0:
            return doc[start:n.start()]
    return doc[start:]


def _clean(s: str | None) -> str | None:
    if not s:
        return None
    s = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s))).strip()
    return s[:300] or None


# ------------------------------------------------------------------ LinkedIn
def linkedin_job_id(url: str) -> str | None:
    p = urlsplit(url)
    if not (p.hostname or "").lower().endswith("linkedin.com"):
        return None
    q = parse_qs(p.query)
    for key in ("currentJobId", "jobId"):
        if q.get(key) and q[key][0].isdigit():
            return q[key][0]
    m = re.search(r"/jobs/view/(?:[^/]*?-)?(\d{6,})", p.path)
    return m.group(1) if m else None


def parse_linkedin(doc: str, url: str) -> Imported | None:
    desc = _between(doc, "show-more-less-html__markup") or _between(doc, "description__text")
    if not desc:
        return None
    title = _clean(_between(doc, "top-card-layout__title") or _between(doc, "topcard__title"))
    company = _clean(_between(doc, "topcard__org-name-link") or _between(doc, "topcard__flavor"))
    location = _clean(_between(doc, "topcard__flavor--bullet"))
    criteria = []
    for m in re.finditer(r"description__job-criteria-subheader[^>]*>(.*?)</h3>.*?description__job-criteria-text[^>]*>(.*?)</span>",
                         doc, re.S):
        k, v = _clean(m.group(1)), _clean(m.group(2))
        if k and v:
            criteria.append(f"{k}: {v}")
    head = "\n".join(x for x in [title, " · ".join(filter(None, [company, location]))] if x)
    text = "\n\n".join(x for x in [head, html_to_text(desc), "\n".join(criteria)] if x)
    return Imported(url=url, text=text, title=title, company=company, location=location, source="linkedin")


# ------------------------------------------------------------------ schema.org JobPosting
def _jobposting(obj: Any) -> dict[str, Any] | None:
    if isinstance(obj, list):
        for o in obj:
            if (r := _jobposting(o)):
                return r
    elif isinstance(obj, dict):
        t = obj.get("@type")
        if t == "JobPosting" or (isinstance(t, list) and "JobPosting" in t):
            return obj
        for k in ("@graph", "mainEntity", "itemListElement"):
            if k in obj and (r := _jobposting(obj[k])):
                return r
    return None


def parse_jsonld(doc: str, url: str) -> Imported | None:
    for m in re.finditer(r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>", doc, re.S | re.I):
        try:
            data = json.loads(html.unescape(m.group(1).strip()) if "&quot;" in m.group(1) else m.group(1).strip())
        except (json.JSONDecodeError, ValueError):
            continue
        jp = _jobposting(data)
        if not jp or not jp.get("description"):
            continue
        title = _clean(str(jp.get("title") or "")) or None
        org = jp.get("hiringOrganization")
        company = _clean(org.get("name") if isinstance(org, dict) else str(org or "")) or None
        loc = jp.get("jobLocation")
        loc0 = loc[0] if isinstance(loc, list) and loc else loc
        addr = loc0.get("address") if isinstance(loc0, dict) else None
        location = _clean(", ".join(str(addr.get(k)) for k in ("addressLocality", "addressRegion", "addressCountry")
                                    if isinstance(addr, dict) and addr.get(k) and isinstance(addr.get(k), str))) if addr else None
        extra = []
        for k, label in (("employmentType", "Employment type"), ("experienceRequirements", "Experience"),
                         ("qualifications", "Qualifications"), ("skills", "Skills"), ("jobLocationType", "Work mode")):
            v = jp.get(k)
            if isinstance(v, (str, list)) and v:
                extra.append(f"{label}: {', '.join(map(str, v)) if isinstance(v, list) else html_to_text(v)}")
        head = "\n".join(x for x in [title, " · ".join(filter(None, [company, location]))] if x)
        text = "\n\n".join(x for x in [head, html_to_text(html.unescape(str(jp["description"]))), "\n".join(extra)] if x)
        return Imported(url=url, text=text, title=title, company=company, location=location, source="jsonld")
    return None


def parse_page(doc: str, url: str) -> Imported | None:
    title = _clean((re.search(r"<title[^>]*>(.*?)</title>", doc, re.S | re.I) or [None, None])[1])
    body = doc
    for marker in ("<main", "<article"):
        i = doc.lower().find(marker)
        if i >= 0:
            body = doc[i:]
            break
    text = html_to_text(body)
    if len(text) < 200:
        return None
    company = None
    site = re.search(r"<meta[^>]+property=[\"']og:site_name[\"'][^>]+content=[\"']([^\"']+)", doc, re.I)
    if title and (m := re.match(r"^(?:Job Application for )?(.+?) (?:at|@) (.+?)$", title)) or title and (m := re.match(r"^(.+?)\s+[|\-–]\s+(.+?)(?:\s+(?:Careers|Jobs))?$", title)):
        title, company = m.group(1).strip(), m.group(2).strip()
    if not company and site:
        company = _clean(site.group(1))
    head = "\n".join(x for x in [title, company] if x)
    return Imported(url=url, text=(f"{head}\n\n{text}" if head else text)[:60000], title=title, company=company,
                    location=None, source="page")


def import_link(url: str) -> Imported:
    url = check_url(url)
    jid = linkedin_job_id(url)
    if jid:
        canonical = f"https://www.linkedin.com/jobs/view/{jid}/"
        # The guest API is light; the public job page carries the same markup. LinkedIn rate-limits bursts (429),
        # so fall back to the page and retry once after a short pause.
        for attempt, target in enumerate((f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jid}", canonical,
                                          canonical)):
            try:
                if attempt == 2:
                    time.sleep(1.5)
                _, doc = _fetch(target)
            except LinkError as e:
                if e.code in ("link_blocked_by_site", "link_timeout", "link_unreachable") and attempt < 2:
                    continue
                raise
            got = parse_linkedin(doc, canonical) or parse_jsonld(doc, canonical)
            if got:
                return got
        raise LinkError("LinkedIn didn't share this job publicly. Open it and use the Prepzy extension, "
                        "or paste the job text instead.", "link_blocked_by_site")
    if (urlsplit(url).hostname or "").lower().endswith("linkedin.com"):
        raise LinkError("Use the link of one LinkedIn job (it contains /jobs/view/ or currentJobId=).", "link_invalid")
    final, doc = _fetch(url)
    got = parse_jsonld(doc, final) or parse_page(doc, final)
    if not got or len(got.text) < 120 or _looks_like_listing(got.text):
        host = (urlsplit(final).hostname or "").lower()
        if any(host.endswith(h) for h in _APP_ONLY):
            raise LinkError(f"{host.removeprefix('www.')} loads its job text inside the page, so it can't be read from "
                            "a link. Open the job and click the Prepzy extension, or paste the job text instead.",
                            "link_needs_extension")
        raise LinkError("Couldn't find a job description on that page. Use the link of one job, open it with the "
                        "Prepzy extension, or paste the job text instead.", "link_no_job")
    return got


# Sites whose job pages are rendered by JavaScript (the posting isn't in the HTML): the extension reads them instead.
_APP_ONLY = ("naukri.com", "indeed.com", "indeed.co.in", "foundit.in", "glassdoor.com", "glassdoor.co.in", "monster.com",
             "instahyre.com", "hirist.tech", "shine.com")


def _looks_like_listing(text: str) -> bool:
    """A search/listing page rather than one job: no requirement-like wording at all."""
    return not re.search(r"(?i)\b(responsib|requirement|qualification|experience|skills?|you will|about the (role|job)|"
                         r"what you|must have|nice to have|job description|duties)\b", text)

"""Deterministic job-text utilities: URL normalization, canonical identity, hashing, quote
location, JSON-LD claim parsing, requirement semantics (alternatives, thresholds, importance)."""

from __future__ import annotations

import hashlib
import re
import unicodedata
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

EXTRACTION_VERSION = "ext-1"

# Only pure tracking params are dropped; everything else (job ids, requisition params) is kept.
_TRACKING = re.compile(r"^(utm_.*|gclid|fbclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi|trk|trackingId|refId|ref|src|source)$",
                       re.IGNORECASE)


def normalize_url(url: str | None) -> str | None:
    if not url:
        return None
    try:
        p = urlsplit(url.strip())
    except ValueError:
        return None
    if p.scheme not in ("http", "https") or not p.netloc:
        return None
    q = [(k, v) for k, v in parse_qsl(p.query, keep_blank_values=True) if not _TRACKING.match(k)]
    q.sort()
    host = p.netloc.lower()
    path = p.path.rstrip("/") or "/"
    return urlunsplit((p.scheme.lower(), host, path, urlencode(q), ""))


def normalize_text(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t ]+", " ", text)
    text = re.sub(r"\n[ \t]+", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def content_hash(text: str) -> str:
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def canonical_key(url: str | None, structured: dict[str, Any] | None, chash: str) -> str:
    """Prefer an explicit source requisition id + host, then normalized URL, then content hash.
    Distinct requisitions are never collapsed because company/title match."""
    nurl = normalize_url(url)
    ident = (structured or {}).get("identifier")
    if isinstance(ident, dict):
        ident = ident.get("value")
    if nurl and isinstance(ident, (str, int)) and str(ident).strip():
        return f"id:{urlsplit(nurl).netloc}:{str(ident).strip()[:200]}"
    if nurl:
        return f"url:{nurl}"[:600]
    return f"hash:{chash}"


_WS = re.compile(r"\s+")


def _squash(s: str) -> tuple[str, list[int]]:
    """Lowercased, whitespace/punctuation-collapsed string plus index map to the original."""
    out: list[str] = []
    idx: list[int] = []
    prev_space = True
    for i, ch in enumerate(s):
        c = ch.lower()
        if c.isalnum() or c in "+#%$.,/&":
            out.append(c)
            idx.append(i)
            prev_space = False
        elif not prev_space:
            out.append(" ")
            idx.append(i)
            prev_space = True
    return "".join(out), idx


def locate_quote(source: str, quote: str) -> tuple[int, int] | None:
    """Find ``quote`` in ``source`` tolerant to whitespace/punctuation/case. Returns original span."""
    q = quote.strip()
    if len(q) < 3:
        return None
    s_sq, s_idx = _squash(source)
    q_sq, _ = _squash(q)
    q_sq = q_sq.strip()
    if not q_sq:
        return None
    pos = s_sq.find(q_sq)
    if pos < 0:
        return None
    end = pos + len(q_sq) - 1
    return s_idx[pos], s_idx[min(end, len(s_idx) - 1)] + 1


_PREFERRED = re.compile(r"\b(preferred|nice[- ]to[- ]have|a plus|is a plus|bonus|desirable|advantageous|good to have|ideally)\b",
                        re.IGNORECASE)
_REQUIRED = re.compile(r"\b(required|must|mandatory|minimum|at least|essential|need to have)\b", re.IGNORECASE)
_YEARS = re.compile(
    r"(?P<min>\d{1,2})(?:\s*(?:\+|plus))?\s*(?:(?:-|–|to)\s*(?P<max>\d{1,2}))?\s*\+?\s*(?:years?|yrs?)\b", re.IGNORECASE)
_NEG = re.compile(r"\b(not required|not necessary|isn't required|not mandatory|no prior experience|"
                  r"no experience (?:is )?(?:needed|required))\b", re.IGNORECASE)


def importance_hint(text: str) -> str | None:
    if _PREFERRED.search(text):
        return "preferred"
    if _REQUIRED.search(text):
        return "required"
    return None


def parse_years(text: str) -> dict[str, Any] | None:
    m = _YEARS.search(text)
    if not m:
        return None
    lo = int(m.group("min"))
    hi = int(m.group("max")) if m.group("max") else None
    if lo > 40 or (hi is not None and (hi < lo or hi > 50)):
        return {"ambiguous": True, "original": m.group(0)}
    return {"min": lo, "max": hi, "unit": "years", "original": m.group(0)}


def group_semantics(text: str, concepts: list[str], spans: dict[str, list[tuple[int, int]]]) -> str:
    """'any' when concepts are joined by or-like connectors ("Python or R", "Java/Kotlin",
    "one of ..."), else 'all'. A single concept is 'single'."""
    if len(concepts) <= 1:
        return "single"
    if re.search(r"\b(one of|either|any of|such as|e\.g\.|for example|like)\b", text, re.IGNORECASE):
        return "any"
    ordered = sorted((spans[c][0][0], spans[c][0][1], c) for c in concepts if c in spans)
    joiners = [text[ordered[i][1]:ordered[i + 1][0]] for i in range(len(ordered) - 1)]
    if joiners and all(re.fullmatch(r"\s*(,|/|\bor\b|,\s*or\b|\|)\s*", j, re.IGNORECASE) for j in joiners) and \
            any(re.search(r"/|\bor\b|\|", j, re.IGNORECASE) for j in joiners):
        return "any"
    return "all"


def is_negated(text: str) -> bool:
    """True when the text states the condition is NOT required (e.g. "A degree is not required")."""
    return bool(_NEG.search(text))


def jsonld_claims(structured: dict[str, Any] | None) -> dict[str, Any]:
    """Extract a few JobPosting fields as *claims* (untrusted, page-supplied)."""
    if not isinstance(structured, dict):
        return {}

    def txt(v: Any) -> str | None:
        if isinstance(v, str):
            return re.sub(r"<[^>]+>", " ", v).strip()[:500] or None
        if isinstance(v, dict):
            return txt(v.get("name"))
        return None

    out: dict[str, Any] = {}
    out["title"] = txt(structured.get("title"))
    out["company"] = txt(structured.get("hiringOrganization"))
    loc = structured.get("jobLocation")
    if isinstance(loc, list) and loc:
        loc = loc[0]
    if isinstance(loc, dict):
        addr = loc.get("address")
        if isinstance(addr, dict):
            parts = [addr.get(k) for k in ("addressLocality", "addressRegion", "addressCountry")]
            out["location"] = ", ".join(str(p if not isinstance(p, dict) else p.get("name", "")) for p in parts if p) or None
    if structured.get("jobLocationType") == "TELECOMMUTE":
        out["work_mode"] = "remote"
    et = structured.get("employmentType")
    out["employment_type"] = ", ".join(et) if isinstance(et, list) else txt(et)
    out["date_posted"] = txt(structured.get("datePosted"))
    out["valid_through"] = txt(structured.get("validThrough"))
    sal = structured.get("baseSalary")
    if isinstance(sal, dict):
        val = sal.get("value") if isinstance(sal.get("value"), dict) else {}
        out["salary"] = {"currency": sal.get("currency"), "min": val.get("minValue"), "max": val.get("maxValue"),
                         "value": val.get("value"), "period": val.get("unitText")}
    return {k: v for k, v in out.items() if v}

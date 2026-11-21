"""ATS score checker: how a company's applicant tracking system is likely to read a resume for one job.

Honest by design: no ATS vendor publishes its ranking algorithm. The checks below follow each system's documented
or widely observed parsing behaviour (field-based parsers such as Workday/Taleo/iCIMS/SuccessFactors drop text in
headers, columns and text boxes and match keywords literally; Greenhouse/Lever/Ashby show the PDF to humans and
support recruiter keyword search). The score is an estimate built from transparent, deterministic rules, so the
same resume and job always get the same result.
"""

from __future__ import annotations

import contextlib
import io
import re
import zipfile
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from .resumes import clean_pdf_text, extract_evidence
from .taxonomy import load_taxonomy


@dataclass(frozen=True)
class AtsProfile:
    id: str
    name: str
    style: str                       # one-line description shown to the user
    strict_parser: bool              # field-based parser that loses columns / headers / text boxes
    exact_keywords: bool             # literal keyword matching (synonyms / abbreviations don't count)
    human_first: bool                # recruiters mostly read the original file
    weights: tuple[float, float, float, float]  # keywords, format, sections, content
    tips: tuple[str, ...]


PROFILES: dict[str, AtsProfile] = {p.id: p for p in [
    AtsProfile("workday", "Workday", "Field-based parser used by many large employers. Fills a profile from your file.",
               True, False, False, (0.45, 0.30, 0.15, 0.10),
               ("Workday copies your resume into form fields — check every field after uploading and fix anything it misread.",
                "Keep contact details in the main body, not in the page header.",
                "Use one column and standard headings (Experience, Education, Skills).")),
    AtsProfile("taleo", "Oracle Taleo", "One of the oldest ATSs. Very literal keyword matching and strict parsing.",
               True, True, False, (0.50, 0.30, 0.12, 0.08),
               ("Use the exact words from the job post — Taleo often doesn't treat 'JS' and 'JavaScript' as the same.",
                "Write acronyms both ways once, e.g. 'Continuous Integration (CI)'.",
                "Avoid tables, text boxes, columns and icons; Taleo frequently drops them.")),
    AtsProfile("icims", "iCIMS", "Parser-based ATS common at mid-size and large companies.",
               True, False, False, (0.45, 0.30, 0.15, 0.10),
               ("Put your name, email and phone as plain text at the very top.",
                "Use simple bullet points; fancy symbols can turn into garbage characters.")),
    AtsProfile("successfactors", "SAP SuccessFactors", "Enterprise ATS with field-based parsing.",
               True, False, False, (0.45, 0.30, 0.15, 0.10),
               ("Keep dates in a consistent format like 'Jun 2025 – Aug 2025'.",
                "Avoid multi-column layouts; the parser reads across columns.")),
    AtsProfile("greenhouse", "Greenhouse", "Recruiters read your original PDF; keyword search helps them find you.",
               False, False, True, (0.40, 0.20, 0.15, 0.25),
               ("A clean, readable design matters most — a person reads it.",
                "Still mirror the job's key skills so recruiter searches find you.")),
    AtsProfile("lever", "Lever", "Human-first ATS. Parses the file for search, shows the original to recruiters.",
               False, False, True, (0.40, 0.20, 0.15, 0.25),
               ("Lead each bullet with impact; recruiters skim the original file.",
                "Mirror the job's key skills for recruiter search.")),
    AtsProfile("ashby", "Ashby", "Modern, human-first ATS with strong search.",
               False, False, True, (0.40, 0.20, 0.15, 0.25),
               ("Keep it to one or two pages and easy to skim.",)),
    AtsProfile("smartrecruiters", "SmartRecruiters", "Parses into a candidate profile; moderate strictness.",
               True, False, False, (0.45, 0.25, 0.15, 0.15),
               ("Check the auto-filled profile after uploading.",)),
    AtsProfile("naukri", "Naukri RMS", "Recruiters search candidates by keywords and skills.",
               False, True, False, (0.55, 0.15, 0.15, 0.15),
               ("Add the job's exact skill keywords to your resume and Naukri profile 'Key skills'.",
                "Keep your headline specific, e.g. 'Java Spring Boot Developer'.")),
    AtsProfile("linkedin", "LinkedIn (Easy Apply)", "Recruiters see your resume and profile; keyword search ranks you.",
               False, False, True, (0.45, 0.15, 0.15, 0.25),
               ("Make sure your LinkedIn profile skills match your resume.",)),
    AtsProfile("generic", "Typical ATS", "No specific system detected — checks against common ATS behaviour.",
               True, False, False, (0.45, 0.30, 0.15, 0.10),
               ("Use one column, standard headings and plain-text contact details.",)),
]}

_HOSTS: list[tuple[str, str]] = [
    (r"myworkdayjobs\.com|workday\.com|wd\d+\.myworkday", "workday"),
    (r"taleo\.net|oraclecloud\.com/hcmUI|fa\.\w+\.oraclecloud", "taleo"),
    (r"icims\.com", "icims"),
    (r"successfactors\.(com|eu)|sapsf\.|jobs\.sap\.com", "successfactors"),
    (r"greenhouse\.io", "greenhouse"),
    (r"lever\.co", "lever"),
    (r"ashbyhq\.com", "ashby"),
    (r"smartrecruiters\.com", "smartrecruiters"),
    (r"naukri\.com", "naukri"),
    (r"linkedin\.com", "linkedin"),
]


def detect_ats(url: str | None, job_text: str = "") -> tuple[str, str]:
    """(profile id, how it was detected)."""
    host = ""
    if url:
        try:
            p = urlsplit(url if "://" in url else "https://" + url)
            host = (p.hostname or "") + p.path[:40]
        except ValueError:
            host = ""
    for pat, pid in _HOSTS:
        if host and re.search(pat, host, re.IGNORECASE):
            return pid, "from the job link"
    brand = {"workday": "Workday", "taleo": "Taleo", "icims": "iCIMS", "successfactors": "SuccessFactors",
             "greenhouse": "Greenhouse", "lever": "Lever", "ashby": "Ashby", "smartrecruiters": "SmartRecruiters"}
    for pid, name in brand.items():
        if re.search(r"powered by\s+" + re.escape(name), job_text[:20000], re.IGNORECASE):
            return pid, "from the job text"
    return "generic", "not detected — using typical ATS rules"


# ------------------------------------------------------------------ file structure
@dataclass
class FileFacts:
    kind: str
    text: str
    pages: int = 1
    images: int = 0
    columns: bool = False
    tables: int = 0
    text_boxes: int = 0
    header_contact: bool = False
    odd_chars: int = 0
    notes: list[str] = field(default_factory=list)


_PUA = re.compile(r"[-�]")


def _pdf_facts(data: bytes) -> FileFacts:
    from pypdf import PdfReader
    reader = PdfReader(io.BytesIO(data))
    if reader.is_encrypted:
        raise ValueError("Password-protected PDFs can't be read by an ATS either. Remove the password and try again.")
    texts: list[str] = []
    images = 0
    left_starts: list[float] = []
    widths: list[float] = []
    for page in reader.pages[:6]:
        w = float(page.mediabox.width or 612)
        widths.append(w)
        starts: list[float] = []

        def visit(text: str, cm: Any, tm: Any, font_dict: Any, font_size: Any, _s: list[float] = starts) -> None:
            # Only long runs of prose: right-aligned dates/places are short and must not look like a column.
            if text and len(text.strip()) >= 25:
                with contextlib.suppress(TypeError, ValueError, IndexError):
                    _s.append(float(tm[4]) * float(cm[0]) + float(cm[4]))
        texts.append(page.extract_text(visitor_text=visit) or "")
        with contextlib.suppress(Exception):  # malformed image objects: count what we can
            images += len(page.images)
        left_starts.extend(x / w for x in starts if 0 <= x <= w)
    from .resumes import poppler_text
    text = poppler_text(data) or clean_pdf_text("\n".join(texts))
    facts = FileFacts(kind="pdf", text=text, pages=len(reader.pages), images=images)
    # Two-column layout: a substantial share of text runs start in the right half of the page.
    if len(left_starts) >= 10:
        right = [x for x in left_starts if 0.40 <= x <= 0.70]
        left = [x for x in left_starts if x < 0.25]
        # A real second column starts every line at the same x; right-aligned dates/tech lists (\hfill) start
        # wherever their length puts them. So require one start position shared by several lines.
        from collections import Counter
        same_x = max(Counter(round(x * 200) for x in right).values(), default=0)  # 0.5% of page width
        if (len(right) >= 3 and len(right) > 0.2 * len(left_starts) and len(left) > 0.3 * len(left_starts)
                and same_x >= max(4, 0.5 * len(right))):
            facts.columns = True
    facts.odd_chars = len(_PUA.findall(text))
    return facts


def _docx_facts(data: bytes) -> FileFacts:
    import docx
    d = docx.Document(io.BytesIO(data))
    body = "\n".join(p.text for p in d.paragraphs)
    tables = len(d.tables)
    cells = []
    for t in d.tables:
        for row in t.rows:
            for c in row.cells:
                if c.text not in cells:
                    cells.append(c.text)
    header_txt = " ".join(p.text for s in d.sections for p in s.header.paragraphs)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        xml = z.read("word/document.xml").decode("utf8", "replace")
    text_boxes = xml.count("<w:txbxContent")
    images = xml.count("<pic:pic") + xml.count("<v:imagedata")
    cols = re.search(r'<w:cols[^>]*w:num="([2-9])"', xml) is not None
    text = body + ("\n" + "\n".join(cells) if cells else "")
    return FileFacts(kind="docx", text=text, tables=tables, text_boxes=text_boxes, images=images, columns=cols,
                     header_contact=bool(re.search(r"@|\+?\d[\d\s-]{8,}", header_txt)),
                     odd_chars=len(_PUA.findall(text)))


def file_facts(data: bytes, kind: str) -> FileFacts:
    return _pdf_facts(data) if kind == "pdf" else _docx_facts(data)


# ------------------------------------------------------------------ keywords
def _text_requirements(job_text: str) -> list[dict[str, Any]]:
    """Requirements from pasted text. Lines under headings like "Requirements" / "Nice to have" take the heading's
    importance; other lines get it from their own wording ("required", "must", "a plus", "preferred")."""
    from .job_analysis import build_requirement, deterministic_requirements, section_requirement_lines
    tax = load_taxonomy()
    reqs: list[dict[str, Any]] = []
    covered: set[str] = set()
    for body, span, imp in section_requirement_lines(job_text):
        if tax.find_in_text(body):
            r = build_requirement(f"s{len(reqs) + 1}", body, span, "skill", imp, "rules")
            reqs.append(r)
            covered |= {c["id"] for c in r["concepts"]}
    has_sections = bool(reqs)
    split = re.sub(r"(?<!\be\.g\.)(?<!\bi\.e\.)(?<=[.;!?])[ \t]+(?=[A-Z0-9])", "\n", job_text)
    for r in deterministic_requirements(split):
        if has_sections:
            # The posting has requirement sections; other lines (intro, duties) only add concrete tools as nice-to-haves,
            # never an industry word like "logistics".
            r["concepts"] = [c for c in r["concepts"] if tax.skills[c["id"]].kind in ("tool", "technical")]
            if r["importance"] in ("unclear", None):
                r["importance"] = "preferred"
        if r["concepts"] and not {c["id"] for c in r["concepts"]} <= covered:
            reqs.append(r)
            covered |= {c["id"] for c in r["concepts"]}
    return reqs


def _nested(text: str) -> set[str]:
    """Concepts found only inside a longer concept's match ("GitHub" inside "GitHub Actions")."""
    found = load_taxonomy().find_in_text(text)
    spans = [(a, b, cid) for cid, ss in found.items() for a, b in ss]
    return {cid for cid, ss in found.items()
            if all(any(o != cid and a2 <= a and b <= b2 and (b2 - a2) > (b - a) for a2, b2, o in spans) for a, b in ss)}


def job_keywords(requirements: list[dict[str, Any]] | None, job_text: str) -> list[dict[str, Any]]:
    """Skills the job asks for: from the analysed requirements when available, else found in the text."""
    tax = load_taxonomy()
    out: dict[str, dict[str, Any]] = {}
    if not requirements and job_text:
        requirements = _text_requirements(job_text)
    if requirements:
        for r in requirements:
            if r.get("removed_by_user") or r.get("negated"):
                continue
            # Listed skills are expected unless the posting marks them optional ("preferred", "nice to have", "plus").
            imp = "preferred" if r.get("importance") in ("preferred", "optional") else "required"
            inner = _nested(r.get("text") or "")
            ids = [c["id"] for c in r.get("concepts", []) if c["id"] in tax.skills and tax.skills[c["id"]].kind != "soft"
                   and c["id"] not in inner]
            # "Java or Kotlin": having any one of them satisfies the requirement.
            alts = ids if r.get("group") == "any" and len(ids) > 1 else []
            for cid in ids:
                cur = out.get(cid)
                if not cur or (cur["importance"] == "preferred" and imp == "required"):
                    out[cid] = {"id": cid, "label": tax.skills[cid].label, "importance": imp,
                                "alternatives": [a for a in alts if a != cid]}
    inner_all = _nested(job_text)
    for cid, spans in tax.find_in_text(job_text).items():
        if cid in inner_all:
            continue
        # Mentions outside the requirement lines (company blurb, perks): only real skills, never an industry word.
        if cid in tax.skills and tax.skills[cid].kind in ("tool", "technical") and cid not in out:
            out[cid] = {"id": cid, "label": tax.skills[cid].label, "importance": "required" if len(spans) > 1 else "preferred",
                        "alternatives": []}
    for cid, k in out.items():
        spans = tax.find_in_text(job_text).get(cid, [])
        k["job_term"] = job_text[spans[0][0]:spans[0][1]] if spans else k["label"]
    return sorted(out.values(), key=lambda k: (k["importance"] != "required", k["label"].lower()))[:40]


# ------------------------------------------------------------------ scoring
def _issue(sev: str, title: str, detail: str, fix: str, area: str) -> dict[str, str]:
    return {"severity": sev, "title": title, "detail": detail, "fix": fix, "area": area}


def check(*, data: bytes | None, kind: str | None, resume_text: str | None, job_text: str, job_url: str | None,
          requirements: list[dict[str, Any]] | None, ats: str | None, job_title: str | None = None) -> dict[str, Any]:
    facts = file_facts(data, kind) if data and kind else FileFacts(kind="text", text=resume_text or "")
    text = facts.text
    if ats and ats in PROFILES and ats != "auto":
        prof, how = PROFILES[ats], "chosen by you"
    else:
        pid, how = detect_ats(job_url, job_text)
        prof = PROFILES[pid]
    issues: list[dict[str, str]] = []

    # --- readable at all?
    words = len(text.split())
    if words < 60:
        issues.append(_issue("high", "The ATS can't read any text",
                             "This file has almost no selectable text — it's probably a scanned image or exported as pictures.",
                             "Export the resume again from Word/Google Docs/Overleaf as a text PDF (you should be able to select the words).",
                             "format"))
        return _result(prof, how, 5, {"keywords": 0, "format": 0, "sections": 0, "content": 0}, [], [], [], issues, facts,
                       extract_evidence(text) if text else {"sections": [], "contact": {}})

    ev = extract_evidence(text)
    tax = load_taxonomy()
    have = tax.find_in_text(text)

    # --- keywords
    kws = job_keywords(requirements, job_text)
    matched, alias_only, missing = [], [], []
    for k in kws:
        if k["id"] in have:
            term = k.get("job_term") or k["label"]
            exact = re.search(r"(?<![A-Za-z0-9])" + re.escape(term) + r"(?![A-Za-z0-9])", text, re.IGNORECASE) is not None
            used_in = sorted({s["name"] for s in ev["sections"] for a, b in have[k["id"]] if s["start"] <= a < s["end"]})
            a0, b0 = have[k["id"]][0]
            row = {**k, "exact": exact, "sections": used_in, "resume_term": text[a0:b0]}
            (matched if exact or not prof.exact_keywords else alias_only).append(row)
        else:
            missing.append(k)
    # Drop "or" alternatives once one of them is on the resume (Java present → Kotlin not missing).
    have_ids = {k["id"] for k in matched + alias_only}
    satisfied = [k for k in missing if set(k.get("alternatives") or []) & have_ids]
    missing = [k for k in missing if k not in satisfied]
    kws = [k for k in kws if k not in satisfied]
    w = {"required": 2.0, "preferred": 1.0}
    total = sum(w[k["importance"]] for k in kws) or 1.0
    got = sum(w[k["importance"]] for k in matched) + 0.5 * sum(w[k["importance"]] for k in alias_only)
    kw_score = round(100 * got / total) if kws else 70
    req_missing = [k for k in missing if k["importance"] == "required"]
    if req_missing:
        issues.append(_issue("high" if len(req_missing) >= 3 else "medium",
                             f"{len(req_missing)} required skill{'s' if len(req_missing) != 1 else ''} not found",
                             "The job asks for " + ", ".join(k["job_term"] for k in req_missing[:8]) + ", but your resume doesn't mention "
                             + ("them." if len(req_missing) > 1 else "it."),
                             "If you have these skills, add them to Skills AND show them in a project or experience bullet. "
                             "Never add skills you don't have — interviews will test them.", "keywords"))
    for k in alias_only[:6]:
        issues.append(_issue("medium", f"Use the exact term '{k['job_term']}'",
                             f"{prof.name} matches words literally. Your resume mentions this skill differently.",
                             f"Write '{k['job_term']}' exactly as the job does (you can keep your version in brackets).", "keywords"))
    listed_only = [k for k in matched if k["sections"] and set(k["sections"]) <= {"skills", "header"}]
    if len(listed_only) >= 3:
        issues.append(_issue("low", "Some skills are only listed, never shown in use",
                             ", ".join(k["label"] for k in listed_only[:6]) + " appear only in your Skills list.",
                             "Mention each in a project or experience bullet (what you built with it). Recruiters and ATS "
                             "ranking both give more weight to skills used in context.", "keywords"))

    # --- format / parsing
    fmt = 100
    if facts.columns:
        fmt -= 45 if prof.strict_parser else 10
        issues.append(_issue("high" if prof.strict_parser else "low", "Two-column layout detected",
                             f"{prof.name} {'reads across columns, mixing your sections together' if prof.strict_parser else 'parses it, but text order can get mixed for search'}.",
                             "Use a single-column layout (all Prepzy templates are single-column).", "format"))
    if facts.tables:
        fmt -= 20 if prof.strict_parser else 5
        issues.append(_issue("medium" if prof.strict_parser else "low", f"{facts.tables} table{'s' if facts.tables > 1 else ''} found",
                             "Table cells are often read out of order or skipped.", "Replace tables with plain lines and bullets.", "format"))
    if facts.text_boxes:
        fmt -= 25 if prof.strict_parser else 8
        issues.append(_issue("high" if prof.strict_parser else "low", "Text boxes found",
                             "Text inside text boxes is commonly ignored by parsers.", "Move that text into the normal page body.", "format"))
    if facts.header_contact:
        fmt -= 20 if prof.strict_parser else 5
        issues.append(_issue("high" if prof.strict_parser else "low", "Contact details are in the page header",
                             f"{prof.name} may skip the document header, so it might not find your email or phone.",
                             "Put your name, email and phone as normal text at the top of the page body.", "format"))
    if facts.odd_chars >= 3:
        fmt -= 10
        issues.append(_issue("medium", "Icons or special symbols turn into unreadable characters",
                             f"{facts.odd_chars} characters came out as unreadable symbols (often icon fonts next to phone/email).",
                             "Keep icons if you like, but make sure the text next to them (email, phone, links) is plain text — or use the ATS Simple template.",
                             "format"))
    if facts.images:
        fmt -= 5
        issues.append(_issue("low", f"{facts.images} image{'s' if facts.images > 1 else ''} found",
                             "ATSs ignore images, and a photo can introduce bias. Most Indian and global tech employers don't expect one.",
                             "Remove photos and logos; anything important must also be in text.", "format"))
    if facts.pages > 2:
        fmt -= 10
        issues.append(_issue("medium", f"{facts.pages} pages", "Recruiters spend seconds per resume; long files bury your best work.",
                             "Keep it to 1 page (students/freshers) or 2 pages (experienced).", "content"))
    fmt = max(0, fmt)

    # --- sections & contact
    names = {s["name"] for s in ev["sections"]}
    sec = 100
    for need, label in (("experience", "Experience"), ("education", "Education"), ("skills", "Skills")):
        if need not in names and not (need == "experience" and "projects" in names):
            sec -= 25
            issues.append(_issue("medium", f"No '{label}' heading found",
                                 "Parsers use standard headings to split your resume into fields.",
                                 f"Add a heading called exactly '{label}'" + (" (or 'Projects' if you're a fresher)." if need == "experience" else "."),
                                 "sections"))
    email = re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text)
    phone = re.search(r"\+?\d[\d\s().-]{8,}\d", text[:3000])
    linkedin = re.search(r"linkedin\.com/in/[\w-]+", text, re.IGNORECASE)
    if not email:
        sec -= 30
        issues.append(_issue("high", "No email address found", "The ATS couldn't find an email in the text it extracted.",
                             "Add your email as plain text near your name.", "sections"))
    if not phone:
        sec -= 15
        issues.append(_issue("medium", "No phone number found", "Many ATS forms require a phone number.",
                             "Add your phone number with country code, e.g. +91 98765 43210.", "sections"))
    if not linkedin:
        issues.append(_issue("low", "No LinkedIn profile link", "Recruiters usually check LinkedIn.",
                             "Add linkedin.com/in/your-name under your name.", "sections"))
    sec = max(0, sec)

    # --- content quality
    con = 100
    if words < 250:
        con -= 25
        issues.append(_issue("medium", f"Very short ({words} words)", "There may not be enough detail to match the job.",
                             "Add 2–4 bullets per project or role describing what you built and the result.", "content"))
    elif words > 1100:
        con -= 15
        issues.append(_issue("low", f"Long ({words} words)", "Long resumes dilute your most relevant work.",
                             "Cut older or unrelated points; keep the ones that match this job.", "content"))
    bullets = len(re.findall(r"^\s*[•●▪■◦\-–*]\s+", text, re.M))
    if bullets < 4 and words > 150:
        con -= 15
        issues.append(_issue("low", "Few bullet points", "Dense paragraphs are harder for people and parsers to scan.",
                             "Break responsibilities into short bullets starting with an action verb (Built, Designed, Improved …).",
                             "content"))
    numbers = len(re.findall(r"\b\d+(\.\d+)?\s*(%|x|\+|k|users|ms|hours|days)\b", text, re.IGNORECASE))
    if numbers == 0 and words > 150:
        con -= 15
        issues.append(_issue("low", "No measurable results",
                             "Numbers (users, % faster, problems solved) make achievements concrete and easy to compare.",
                             "Add a real number to 2–3 bullets — only numbers you can explain in an interview.", "content"))
    if any(e.get("issue") for e in ev.get("experience", [])):
        con -= 10
        issues.append(_issue("medium", "A date range looks wrong", "At least one entry ends before it starts.",
                             "Check the dates in your experience section.", "content"))
    if job_title:
        core = [t for t in re.findall(r"[A-Za-z][A-Za-z+#.]{2,}", job_title) if t.lower() not in
                {"senior", "junior", "intern", "the", "and", "for", "with", "level", "associate", "lead", "remote", "hybrid"}]
        if core and not any(re.search(re.escape(t), text, re.IGNORECASE) for t in core[:3]):
            issues.append(_issue("low", "The job title isn't on your resume",
                                 f"Recruiters often search by title (“{job_title}”).",
                                 "Use a headline or summary that names the role, e.g. “Aspiring Backend Developer”.", "keywords"))
    con = max(0, con)

    comps = {"keywords": kw_score, "format": fmt, "sections": sec, "content": con}
    wk, wf, ws, wc = prof.weights
    score = round(wk * kw_score + wf * fmt + ws * sec + wc * con)
    if prof.strict_parser and fmt < 60:
        score = min(score, 55)  # a badly parsed file can't rank well however good the content is
    return _result(prof, how, score, comps, matched, alias_only, missing, issues, facts, ev, email, phone, linkedin)


def _result(prof: AtsProfile, how: str, score: int, comps: dict[str, int], matched: list, alias_only: list, missing: list,
            issues: list, facts: FileFacts, ev: dict[str, Any], email: Any = None, phone: Any = None, linkedin: Any = None
            ) -> dict[str, Any]:
    order = {"high": 0, "medium": 1, "low": 2}
    issues.sort(key=lambda i: order.get(i["severity"], 3))
    grade = "Excellent" if score >= 85 else "Good" if score >= 70 else "Needs work" if score >= 50 else "Poor"
    wk, wf, ws, wc = prof.weights
    return {
        "score": max(0, min(100, score)), "grade": grade,
        "ats": {"id": prof.id, "name": prof.name, "style": prof.style, "detected": how, "tips": list(prof.tips),
                "strict_parser": prof.strict_parser, "exact_keywords": prof.exact_keywords, "human_first": prof.human_first},
        "components": [{"id": k, "label": lbl, "score": comps[k], "weight": round(wt * 100)} for k, lbl, wt in
                       (("keywords", "Keyword match", wk), ("format", "Parsing & format", wf),
                        ("sections", "Sections & contact", ws), ("content", "Content quality", wc))],
        "keywords": {"matched": matched, "alias_only": alias_only, "missing": missing},
        "issues": issues,
        "parsed": {
            "kind": facts.kind, "pages": facts.pages, "words": len(facts.text.split()),
            "email": email.group(0) if email else None, "phone": phone.group(0).strip() if phone else None,
            "linkedin": linkedin.group(0) if linkedin else None,
            "sections": [s["heading"] for s in ev.get("sections", [])],
            "text": facts.text[:6000],
        },
        "disclaimer": "ATS vendors don't publish their ranking formulas. This estimate follows each system's documented parsing "
                      "behaviour and the job's own keywords, so you can fix real problems before applying.",
    }

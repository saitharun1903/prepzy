"""Resume upload validation, private storage, parsing and deterministic evidence extraction.

Supported: text-based PDF, DOCX, and manual text. Scanned/image-only, encrypted, legacy .doc and
other formats are rejected with an explanation (no OCR in this release). Parsers run with bounded
input; DOCX is read as a ZIP with size/ratio limits; no macros are executed (python-docx never
executes VBA) and XML is parsed by lxml with entity resolution disabled by python-docx defaults.
"""

from __future__ import annotations

import hashlib
import io
import re
import uuid
import zipfile
from datetime import date
from pathlib import Path
from typing import Any

from ..config import get_settings
from ..errors import ValidationFailed
from .taxonomy import load_taxonomy

PARSER_VERSION = "resume-parse-1"
SUPPORTED = {"pdf": "application/pdf",
             "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document"}
MAX_TEXT = 60_000


def user_dir(owner_id: uuid.UUID) -> Path:
    p = get_settings().data_dir / "users" / str(owner_id)
    p.mkdir(parents=True, exist_ok=True)
    return p


def detect_kind(data: bytes, filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    if data.startswith(b"%PDF-"):
        kind = "pdf"
    elif data.startswith(b"PK\x03\x04"):
        kind = "docx"
    elif data.startswith(b"\xd0\xcf\x11\xe0"):
        raise ValidationFailed("Legacy .doc files are not supported. Save as .docx or PDF, or paste the text.",
                               code="unsupported_format")
    else:
        raise ValidationFailed("Unsupported file. Upload a text-based PDF or a DOCX file.", code="unsupported_format")
    if ext and ext != kind:
        raise ValidationFailed(f"The file content is {kind.upper()} but the name ends in .{ext}.", code="type_mismatch")
    if kind == "docx":
        _check_docx_zip(data)
    return kind


def _check_docx_zip(data: bytes) -> None:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()
            if len(infos) > 500:
                raise ValidationFailed("DOCX has too many parts.", code="unsafe_file")
            total = sum(i.file_size for i in infos)
            if total > 50 * 1024 * 1024 or total > 100 * max(1, len(data)):
                raise ValidationFailed("DOCX decompresses to an unsafe size.", code="unsafe_file")
            names = {i.filename for i in infos}
            if "word/document.xml" not in names or "[Content_Types].xml" not in names:
                raise ValidationFailed("This ZIP file is not a Word document.", code="unsupported_format")
            if any(n.lower().endswith("vbaproject.bin") for n in names):
                raise ValidationFailed("Macro-enabled documents are not accepted.", code="unsafe_file")
    except zipfile.BadZipFile as e:
        raise ValidationFailed("The DOCX file is damaged.", code="malformed_file") from e


# PDF text from LaTeX/Word exports often splits a word after its first capital ("T elangana",
# "W eb", "CGP A"). Re-join only these unambiguous shapes; "I" and "A" stay separate words.
_SPLIT_CAP = re.compile(r"\b([B-HJ-Z]) ([a-z]{2,})\b")
_SPLIT_GPA = re.compile(r"\b(CGP|SGP|GP) A\b")


_HEADING_WORDS = ["professional summary", "summary", "profile", "objective", "work experience", "professional experience",
                  "experience", "internships", "projects", "academic projects", "personal projects", "technical skills",
                  "skills", "key skills", "education", "certifications", "achievements", "achievements & certifications",
                  "achievements and certifications", "awards", "publications", "languages", "interests", "extracurricular activities"]
_HEADING_BY_SQUASHED = {re.sub(r"[^a-z&]", "", h): h for h in _HEADING_WORDS}


def _fix_heading(line: str) -> str:
    """PDF letter-spacing splits capitalised headings ("EDUCA TION"); restore known section headings."""
    t = line.strip()
    if 3 <= len(t) <= 45 and t.upper() == t and any(c.isalpha() for c in t):
        h = _HEADING_BY_SQUASHED.get(re.sub(r"[^a-z&]", "", t.lower()))
        if h:
            return h.upper()
    return line


def clean_pdf_text(text: str) -> str:
    text = _SPLIT_GPA.sub(r"\1A", _SPLIT_CAP.sub(r"\1\2", text))
    return "\n".join(_fix_heading(ln) for ln in text.split("\n"))


def poppler_text(data: bytes) -> str | None:
    """Text via poppler's pdftotext when installed: it keeps the spaces around bold words that pypdf drops
    ("a live online IDE where", not "alive online IDEwhere"). Runs with CPU/memory limits and a timeout."""
    import shutil
    import subprocess
    import tempfile
    exe = shutil.which("pdftotext")
    if not exe:
        return None

    def limits() -> None:
        import resource
        resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
        resource.setrlimit(resource.RLIMIT_AS, (768 * 1024 * 1024, 768 * 1024 * 1024))

    try:
        with tempfile.TemporaryDirectory() as d:
            src = Path(d) / "in.pdf"
            src.write_bytes(data)
            out = subprocess.run([exe, "-q", "-enc", "UTF-8", "-nopgbrk", "-l", str(get_settings().max_resume_pages),  # noqa: S603
                                  str(src), "-"], capture_output=True, timeout=15, preexec_fn=limits, check=False)
        text = out.stdout.decode("utf-8", "replace") if out.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return None
    text = re.sub(r"[ \t]+\n", "\n", text).replace("\x0c", "\n")
    return text if len(re.sub(r"\s", "", text)) >= 100 else None


def extract_text(data: bytes, kind: str) -> tuple[str, list[str]]:
    """Return (text, warnings). Raises ValidationFailed for unsupported content."""
    warnings: list[str] = []
    if kind == "pdf":
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
        try:
            reader = PdfReader(io.BytesIO(data))
            if reader.is_encrypted:
                raise ValidationFailed("Password-protected PDFs are not supported.", code="encrypted_file")
            pages = reader.pages
            if len(pages) > get_settings().max_resume_pages:
                raise ValidationFailed(f"Resumes are limited to {get_settings().max_resume_pages} pages.",
                                       code="too_many_pages")
            parts = [(p.extract_text() or "") for p in pages]
        except PdfReadError as e:
            raise ValidationFailed("The PDF could not be read (it may be damaged).", code="malformed_file") from e
        text = poppler_text(data) or clean_pdf_text("\n".join(parts))
        if len(re.sub(r"\s", "", text)) < 100:
            raise ValidationFailed("This PDF has no extractable text (it may be scanned). OCR is not available; "
                                   "upload a text-based PDF/DOCX or paste your resume text.", code="no_text_layer")
    else:
        import docx
        d = docx.Document(io.BytesIO(data))
        lines = [p.text for p in d.paragraphs]
        if d.tables:
            warnings.append("Tables detected: some applicant tracking systems read tables poorly.")
            for t in d.tables:
                for row in t.rows:
                    cells = []
                    for c in row.cells:
                        if c.text not in cells:
                            cells.append(c.text)
                    lines.append(" | ".join(cells))
        text = "\n".join(lines)
        if len(text.strip()) < 100:
            raise ValidationFailed("The document contains too little text to analyse.", code="no_text_layer")
    text = text.replace("\x00", "")
    if len(text) > MAX_TEXT:
        warnings.append(f"Text truncated to {MAX_TEXT} characters.")
        text = text[:MAX_TEXT]
    return text, warnings


# ------------------------------------------------------------------ deterministic extraction
_HEADINGS = {
    "summary": r"(professional\s+)?summary|profile|objective|about me",
    "experience": r"(work|professional|employment)?\s*(experience|history)|internships?",
    "projects": r"(academic\s+|personal\s+|key\s+)?projects",
    "skills": r"(technical\s+|key\s+|core\s+)?(skills|competencies|technologies|tech stack|tools)",
    "education": r"education|academic(s| background| qualifications)?|qualifications",
    "certifications": r"certifications?|licen[cs]es|courses|training",
    "achievements": r"achievements|awards|honou?rs|accomplishments",
}
_HEAD_RE = re.compile(r"^\s*(" + "|".join(f"(?P<{k}>{v})" for k, v in _HEADINGS.items()) + r")\s*:?\s*$",
                      re.IGNORECASE)
_MONTHS = {m: i + 1 for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}
_DATE = r"(?:(?P<{p}m>jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*|(?P<{p}n>\d{{1,2}})[/\-.])?(?P<{p}y>(?:19|20)\d{{2}})"
_RANGE = re.compile(_DATE.format(p="a") + r"\s*(?:-|–|—|to|until)\s*(?:(?P<present>present|current|now|till date|ongoing)|"
                    + _DATE.format(p="b") + ")", re.IGNORECASE)


def _ym(m: str | None, n: str | None, y: str) -> tuple[int, int]:
    month = _MONTHS.get((m or "")[:3].lower()) if m else (int(n) if n and 1 <= int(n) <= 12 else 1)
    return int(y), month or 1


def merge_months(ranges: list[tuple[tuple[int, int], tuple[int, int]]]) -> int:
    """Total months covered by possibly-overlapping ranges, counted once."""
    iv = sorted((a[0] * 12 + a[1] - 1, b[0] * 12 + b[1] - 1) for a, b in ranges if b >= a)
    total, cur_s, cur_e = 0, None, None
    for s, e in iv:
        if cur_s is None:
            cur_s, cur_e = s, e
        elif s <= cur_e + 1:
            cur_e = max(cur_e, e)
        else:
            total += cur_e - cur_s + 1
            cur_s, cur_e = s, e
    if cur_s is not None:
        total += cur_e - cur_s + 1
    return total


def split_sections(text: str) -> list[dict[str, Any]]:
    sections: list[dict[str, Any]] = []
    pos = 0
    current = {"name": "header", "heading": None, "start": 0}
    for line in text.splitlines(keepends=True):
        stripped = line.strip()
        m = _HEAD_RE.match(stripped) if 2 < len(stripped) < 45 else None
        if m:
            current["end"] = pos
            sections.append(current)
            name = next(k for k in _HEADINGS if m.group(k))
            current = {"name": name, "heading": stripped.rstrip(":"), "start": pos + len(line)}
        pos += len(line)
    current["end"] = len(text)
    sections.append(current)
    return [s for s in sections if s["end"] > s["start"] or s["heading"]]


def extract_evidence(text: str, today: date | None = None) -> dict[str, Any]:
    today = today or date.today()
    tax = load_taxonomy()
    sections = split_sections(text)

    def section_of(i: int) -> str:
        for s in sections:
            if s["start"] <= i < s["end"]:
                return s["name"]
        return "header"

    skills = []
    for sid, spans in tax.find_in_text(text).items():
        secs = sorted({section_of(s) for s, _ in spans})
        ev = "professional" if "experience" in secs else "project" if "projects" in secs else \
            "certification" if "certifications" in secs else "listed"
        skills.append({"id": sid, "label": tax.skills[sid].label, "spans": [list(s) for s in spans[:5]],
                       "sections": secs, "evidence_type": ev, "mentions": len(spans)})
    skills.sort(key=lambda s: s["label"].lower())

    exp_ranges = []
    experience = []
    exp_secs = [s for s in sections if s["name"] == "experience"] or []
    for s in exp_secs:
        chunk = text[s["start"]:s["end"]]
        for m in _RANGE.finditer(chunk):
            a = _ym(m.group("am"), m.group("an"), m.group("ay"))
            b = (today.year, today.month) if m.group("present") else _ym(m.group("bm"), m.group("bn"), m.group("by"))
            line_start = chunk.rfind("\n", 0, m.start()) + 1
            line_end = chunk.find("\n", m.end())
            line = chunk[line_start: line_end if line_end > 0 else len(chunk)].strip()
            entry = {"line": line[:200], "start": f"{a[0]:04d}-{a[1]:02d}",
                     "end": "present" if m.group("present") else f"{b[0]:04d}-{b[1]:02d}",
                     "span": [s["start"] + m.start(), s["start"] + m.end()]}
            if b < a:
                entry["issue"] = "End date is before start date"
            else:
                exp_ranges.append((a, b))
            experience.append(entry)

    def lines_of(name: str) -> list[dict[str, Any]]:
        out = []
        for s in sections:
            if s["name"] == name:
                off = s["start"]
                for ln in text[s["start"]:s["end"]].splitlines(keepends=True):
                    t = ln.strip(" •-*\t\r\n")
                    if len(t) > 3:
                        out.append({"text": t[:300], "span": [off, off + len(ln)]})
                    off += len(ln)
        return out[:40]

    warnings = []
    names = {s["name"] for s in sections}
    for need in ("experience", "education", "skills"):
        if need not in names:
            warnings.append(f"No '{need}' section heading detected.")
    return {
        "parser_version": PARSER_VERSION,
        "taxonomy_version": tax.version,
        "sections": [{"name": s["name"], "heading": s["heading"], "start": s["start"], "end": s["end"]} for s in sections],
        "skills": skills,
        "experience": experience,
        "experience_months": merge_months(exp_ranges) if exp_ranges else None,
        "education": lines_of("education"),
        "certifications": lines_of("certifications"),
        "projects": lines_of("projects"),
        "contact": {"email_present": bool(re.search(r"[\w.+-]+@[\w-]+\.[\w.]+", text[:2000])),
                    "phone_present": bool(re.search(r"\+?\d[\d\s().-]{8,}\d", text[:2000]))},
        "warnings": warnings,
    }


def effective_skills(extracted: dict[str, Any] | None, reviewed: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    """Resume skills after the user's review: removed ids dropped, added ids marked user_confirmed."""
    out: dict[str, dict[str, Any]] = {}
    for s in (extracted or {}).get("skills", []):
        out[s["id"]] = {"id": s["id"], "label": s["label"], "evidence_type": s["evidence_type"],
                        "source": "resume", "spans": s.get("spans", [])}
    rv = reviewed or {}
    for sid in rv.get("removed_skills", []):
        out.pop(sid, None)
    tax = load_taxonomy()
    for add in rv.get("added_skills", []):
        if add.get("id") in tax.skills:
            out[add["id"]] = {"id": add["id"], "label": tax.skills[add["id"]].label,
                              "evidence_type": add.get("evidence_type", "self_reported"), "source": "user_review",
                              "spans": []}
    return out


def store_file(owner_id: uuid.UUID, data: bytes) -> tuple[str, str]:
    """Save to private storage (local disk or S3, per configuration). Returns (name, sha256)."""
    from .storage import get_storage
    name = f"{uuid.uuid4().hex}.bin"
    get_storage().put(owner_id, name, data)
    return name, hashlib.sha256(data).hexdigest()


def read_file(owner_id: uuid.UUID, storage_name: str) -> bytes:
    from .storage import get_storage
    return get_storage().get(owner_id, storage_name)


def delete_file(owner_id: uuid.UUID, storage_name: str) -> None:
    from .storage import get_storage
    get_storage().delete(owner_id, storage_name)


# ------------------------------------------------------------------ ATS-related guidance
def ats_findings(text: str, extracted: dict[str, Any], job_concepts: list[dict[str, Any]] | None = None
                 ) -> list[dict[str, Any]]:
    """Explainable checks. Not a reproduction of any proprietary ATS; no single score."""
    f: list[dict[str, Any]] = []
    names = {s["name"] for s in extracted.get("sections", [])}
    for need, why in (("experience", "Most parsers look for an Experience heading."),
                      ("education", "An Education heading helps parsers find degrees."),
                      ("skills", "A Skills heading makes tools easy to locate.")):
        if need not in names:
            f.append({"id": f"missing_{need}", "severity": "medium", "category": "structure",
                      "message": f"No clear '{need.title()}' section heading found.", "why": why})
    if not extracted.get("contact", {}).get("email_present"):
        f.append({"id": "no_email", "severity": "high", "category": "structure",
                  "message": "No email address detected near the top.", "why": "Recruiters need a contact method."})
    words = len(text.split())
    if words < 150:
        f.append({"id": "too_short", "severity": "medium", "category": "content",
                  "message": f"The resume is short ({words} words).", "why": "There may be too little evidence to assess."})
    elif words > 1400:
        f.append({"id": "too_long", "severity": "low", "category": "content",
                  "message": f"The resume is long ({words} words).", "why": "Consider focusing on the most relevant work."})
    long_lines = [ln for ln in text.splitlines() if len(ln) > 350]
    if long_lines:
        f.append({"id": "dense_paragraphs", "severity": "low", "category": "formatting",
                  "message": f"{len(long_lines)} very long line(s)/paragraph(s).", "why": "Short bullet points are easier to scan."})
    if any(e.get("issue") for e in extracted.get("experience", [])):
        f.append({"id": "date_conflict", "severity": "medium", "category": "consistency",
                  "message": "At least one experience entry has an end date before its start date.", "why": "Inconsistent dates confuse readers."})
    styles = set()
    for e in extracted.get("experience", []):
        styles.add("numeric" if re.match(r"\d", e["start"]) and re.search(r"\d{1,2}[/\-.]\d{4}", e["line"]) else "named")
    if len(styles) > 1:
        f.append({"id": "mixed_date_formats", "severity": "low", "category": "consistency",
                  "message": "Dates use mixed formats (e.g. 03/2022 and March 2022).", "why": "Consistent formatting reads more professionally."})
    for w in extracted.get("warnings", []):
        if w.startswith("Tables"):
            f.append({"id": "tables", "severity": "low", "category": "parsing", "message": w,
                      "why": "Some parsers read table cells out of order."})
    if job_concepts:
        have = {s["id"] for s in extracted.get("skills", [])}
        missing = [c for c in job_concepts if c["id"] not in have]
        if missing:
            f.append({"id": "job_keywords_absent", "severity": "info", "category": "relevance",
                      "message": "Job skills not mentioned in this resume: " + ", ".join(c["label"] for c in missing[:12]),
                      "why": "Only add these if you genuinely have the skill — never add keywords you can't support.",
                      "skills": [c["id"] for c in missing]})
    return f

"""One-click ATS fix: put the job's exact keywords into the user's own (structured) resume.

Two honest changes only:
1. Renames (Skills section only): a tool the resume lists under another name ("Postgres") is written the way the
   job writes it ("PostgreSQL"), because strict ATSs match words literally.
2. Additions: skills the user ticked as "I have this" are added to the Skills section. Nothing else is added.
"""

from __future__ import annotations

import re
from typing import Any

_GROUP_HINT = re.compile(r"tool|technolog|framework|other|skill", re.IGNORECASE)


def _word(term: str) -> re.Pattern[str]:
    return re.compile(r"(?<![A-Za-z0-9])" + re.escape(term) + r"(?![A-Za-z0-9])", re.IGNORECASE)


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[\\{}$%#&^~<>]", "", s)).strip()[:60]


def rename_ok(src: str, dst: str) -> bool:
    """Only swap one name of a tool for another (React -> ReactJS, Postgres -> PostgreSQL): never for a generic word
    ("containers") or a phrase ("REST API design")."""
    if not src or not dst or src.lower() == dst.lower():
        return False
    if not re.search(r"[A-Z0-9+#.]", dst) or len(dst.split()) > 2 or len(dst.split()) > len(src.split()) + 1:
        return False
    return not re.search(r"\b(design|development|experience|skills?|knowledge|concepts?|systems?|pipelines?)\b", dst, re.IGNORECASE)


def apply_keywords(resume: dict[str, Any], add_skills: list[str], renames: list[dict[str, str]]) -> tuple[dict[str, Any], list[str], list[str]]:
    """Returns (resume, added, renamed). Pure function; never invents beyond the user's confirmed list."""
    added: list[str] = []
    renamed: list[str] = []
    for r in renames:
        src, dst = _clean(r.get("from_term", "")), _clean(r.get("to_term", ""))
        if not rename_ok(src, dst):
            continue
        pat = _word(src)
        hit = False
        for g in resume.get("skills", []):  # only the Skills section: bullets and summary stay as the user wrote them
            new = [pat.sub(lambda _m, d=dst: d, i) for i in g.get("items", [])]
            hit = hit or new != g.get("items", [])
            g["items"] = new
        if hit:
            renamed.append(f"{src} → {dst}")

    groups = resume.setdefault("skills", [])
    present = {i.lower() for g in groups for i in g.get("items", [])}
    for raw in add_skills:
        skill = re.sub(r"\s+", " ", raw).strip()[:60]
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9 +#./&()-]*", skill or "") or not skill or skill.lower() in present:
            continue
        target = next((g for g in groups if _GROUP_HINT.search(g.get("group", ""))), groups[-1] if groups else None)
        if target is None:
            target = {"group": "Skills", "items": []}
            groups.append(target)
        target.setdefault("items", []).append(skill)
        present.add(skill.lower())
        added.append(skill)
    return resume, added, renamed

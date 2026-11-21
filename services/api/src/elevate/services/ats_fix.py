"""One-click ATS fix: put the job's exact keywords into the user's own (structured) resume.

Two honest changes only:
1. Renames: a skill the resume already shows in other words ("Postgres") is written the way the job writes it
   ("PostgreSQL"), because strict ATSs match words literally.
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


def apply_keywords(resume: dict[str, Any], add_skills: list[str], renames: list[dict[str, str]]) -> tuple[dict[str, Any], list[str], list[str]]:
    """Returns (resume, added, renamed). Pure function; never invents beyond the user's confirmed list."""
    added: list[str] = []
    renamed: list[str] = []
    for r in renames:
        src, dst = _clean(r.get("from_term", "")), _clean(r.get("to_term", ""))
        if not src or not dst or src.lower() == dst.lower():
            continue
        pat, before = _word(src), repr(resume)

        def sub(text: str | None, pat: re.Pattern[str] = pat, dst: str = dst) -> str | None:
            return pat.sub(lambda _m: dst, text) if text else text

        resume["summary"] = sub(resume.get("summary"))
        for g in resume.get("skills", []):
            g["items"] = [sub(i) or i for i in g.get("items", [])]
        for sec in ("experience", "projects"):
            for e in resume.get(sec, []):
                e["bullets"] = [sub(b) or b for b in e.get("bullets", [])]
                e["tech"] = sub(e.get("tech"))
        if repr(resume) != before:
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

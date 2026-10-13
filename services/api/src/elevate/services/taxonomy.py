"""Versioned skill taxonomy (database/reference-data/taxonomy). Deterministic normalization only:
exact label/reviewed-alias matches. Related concepts are exposed separately and never treated as
equivalent. Embedding proximity is never used to create aliases."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from functools import lru_cache

from ..config import REPO_ROOT

TAXONOMY_PATH = REPO_ROOT / "database" / "reference-data" / "taxonomy" / "taxonomy.v1.json"

# Labels that are ordinary words or single letters: only matched case-sensitively as whole tokens.
_CASE_SENSITIVE = {"go": "Go", "r_lang": "R", "c_lang": "C"}


@dataclass(frozen=True)
class Skill:
    id: str
    label: str
    domains: tuple[str, ...]
    aliases: tuple[str, ...]
    related: tuple[str, ...]
    prereqs: tuple[str, ...]
    kind: str


@dataclass(frozen=True)
class Domain:
    id: str
    label: str
    role_keywords: tuple[str, ...]
    interview_kinds: tuple[str, ...]


@dataclass
class Taxonomy:
    version: str
    skills: dict[str, Skill]
    domains: dict[str, Domain]
    _phrases: list[tuple[re.Pattern[str], str]] = field(default_factory=list)
    _exact: dict[str, str] = field(default_factory=dict)

    def resolve(self, term: str) -> str | None:
        """Exact (case-insensitive) label/alias resolution of a single term."""
        t = _norm(term)
        if not t:
            return None
        for sid, cs in _CASE_SENSITIVE.items():
            if term.strip() == cs:
                return sid
        return self._exact.get(t)

    def find_in_text(self, text: str) -> dict[str, list[tuple[int, int]]]:
        """All concept ids mentioned in text with character spans (deduplicated by concept)."""
        found: dict[str, list[tuple[int, int]]] = {}
        for pat, sid in self._phrases:
            for m in pat.finditer(text):
                found.setdefault(sid, []).append((m.start(), m.end()))
        return found

    def related(self, a: str, b: str) -> bool:
        sa, sb = self.skills.get(a), self.skills.get(b)
        return bool(sa and sb and (b in sa.related or a in sb.related))

    def classify_domains(self, title: str, text: str, skill_ids: list[str]) -> list[tuple[str, float]]:
        """Deterministic domain suggestion: role keywords in title (weight 3) / text (1) + skill domains (0.5).
        Returns plausible domains sorted; hybrid roles get several. User may override."""
        score: dict[str, float] = {}
        tl, xl = title.lower(), text.lower()[:4000]
        for d in self.domains.values():
            for kw in d.role_keywords:
                if re.search(rf"\b{re.escape(kw)}\b", tl):
                    score[d.id] = score.get(d.id, 0) + 3
                elif re.search(rf"\b{re.escape(kw)}\b", xl):
                    score[d.id] = score.get(d.id, 0) + 1
        for sid in skill_ids:
            s = self.skills.get(sid)
            if s and s.kind != "soft" and len(s.domains) < 6:
                for d in s.domains:
                    score[d] = score.get(d, 0) + 0.5 / len(s.domains)
        if not score:
            return []
        top = max(score.values())
        return sorted(((d, round(v / top, 2)) for d, v in score.items() if v >= top * 0.5), key=lambda x: -x[1])


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


@lru_cache
def load_taxonomy() -> Taxonomy:
    raw = json.loads(TAXONOMY_PATH.read_text(encoding="utf-8"))
    skills = {s["id"]: Skill(s["id"], s["label"], tuple(s["domains"]), tuple(s["aliases"]), tuple(s["related"]),
                             tuple(s["prereqs"]), s["kind"]) for s in raw["skills"]}
    domains = {d["id"]: Domain(d["id"], d["label"], tuple(d["role_keywords"]), tuple(d["interview_kinds"]))
               for d in raw["domains"]}
    tax = Taxonomy(raw["version"], skills, domains)
    entries: list[tuple[str, str]] = []
    for s in skills.values():
        if s.id in _CASE_SENSITIVE:
            continue
        for phrase in (s.label, *s.aliases):
            tax._exact.setdefault(_norm(phrase), s.id)
            entries.append((phrase, s.id))
    # Longest phrases first so "spring boot" wins over "spring".
    entries.sort(key=lambda e: -len(e[0]))
    for phrase, sid in entries:
        esc = re.escape(phrase.lower()).replace(r"\ ", r"\s+")
        tax._phrases.append((re.compile(rf"(?<![\w+#.]){esc}(?![\w+#])", re.IGNORECASE), sid))
    tax._phrases.append((re.compile(r"(?<![\w.])Go(?:lang)?(?![\w+#])"), "go"))
    tax._phrases.append((re.compile(r"(?<![\w.\-/])R(?![\w+#&\-/'])(?!\.\w)"), "r_lang"))
    tax._phrases.append((re.compile(r"(?<![\w.\-/])C(?![\w+#&\-/'])(?!\.\w)"), "c_lang"))
    tax._exact["golang"] = "go"
    return tax

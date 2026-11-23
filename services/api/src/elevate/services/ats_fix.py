"""One-click ATS fix: put the job's exact keywords into the user's own (structured) resume.

Two honest changes only:
1. Renames (Skills section only): a tool the resume lists under another name ("Postgres") is written the way the
   job writes it ("PostgreSQL"), because strict ATSs match words literally.
2. Additions: skills the user ticked as "I have this" are added to the Skills section. Nothing else is added.
"""

from __future__ import annotations

import re
from typing import Any

# Which kind of skill a keyword is, and which of the user's own Skills groups that kind belongs in.
_KINDS: list[tuple[str, set[str], str]] = [
    ("language", {"python", "java", "javascript", "typescript", "c", "c++", "c#", "go", "golang", "rust", "kotlin", "swift",
                  "ruby", "php", "scala", "r", "sql", "html", "html5", "css", "css3", "bash", "shell", "dart", "matlab",
                  "perl", "objective-c", "solidity", "haskell", "elixir", "lua", "groovy", "julia"},
     r"language|programming|coding"),
    ("database", {"mysql", "postgresql", "postgres", "mongodb", "redis", "oracle", "sqlite", "cassandra", "dynamodb",
                  "elasticsearch", "firebase", "mariadb", "neo4j", "snowflake", "bigquery", "sql server", "nosql"},
     r"database|\bdb|data ?stor|storage"),
    ("cloud", {"aws", "azure", "gcp", "google cloud", "docker", "kubernetes", "k8s", "terraform", "jenkins", "ansible",
               "ci/cd", "github actions", "gitlab ci", "kafka", "apache kafka", "rabbitmq", "linux", "nginx", "helm",
               "openshift", "heroku", "vercel", "serverless", "lambda", "prometheus", "grafana"},
     r"cloud|devops|infra|platform|deploy|ops"),
    ("framework", {"react", "reactjs", "react.js", "angular", "vue", "vue.js", "next.js", "nextjs", "node.js", "nodejs",
                   "express", "express.js", "django", "flask", "fastapi", "spring", "spring boot", "jpa", "hibernate",
                   ".net", "asp.net", "redux", "flutter", "react native", "tensorflow", "pytorch", "keras", "pandas",
                   "numpy", "scikit-learn", "tailwind", "bootstrap", "jquery", "graphql", "laravel", "rails", "junit",
                   "selenium", "jest", "spark", "hadoop", "langchain"},
     r"framework|librar|frontend|front-end|backend|back-end|web|stack"),
    ("tool", {"git", "github", "gitlab", "jira", "postman", "figma", "maven", "gradle", "vs code", "intellij", "tableau",
              "power bi", "excel", "webpack", "vite", "npm", "confluence", "linux"},
     r"tool|software|technolog"),
]


def _kind(skill: str) -> str:
    k = skill.lower()
    for name, words, _ in _KINDS:
        if k in words:
            return name
    return "concept" if (" " in k or k.islower()) else "tool"


def best_group(groups: list[dict[str, Any]], skill: str) -> dict[str, Any] | None:
    """The user's own Skills group this skill belongs in (Languages, Frameworks, Cloud...), else a general one."""
    if not groups:
        return None
    kind = _kind(skill)
    hint = {n: h for n, _, h in _KINDS}.get(kind, r"concept|core|area|competenc|knowledge|fundamental|other")
    for g in groups:
        if re.search(hint, g.get("group", ""), re.IGNORECASE):
            return g
    if kind == "concept":
        for g in groups:
            if re.search(r"concept|core|area|competenc|knowledge|fundamental|other", g.get("group", ""), re.IGNORECASE):
                return g
    general = re.compile(r"tool|technolog|other|skill|general|misc", re.IGNORECASE)
    return next((g for g in groups if general.search(g.get("group", ""))), groups[-1])


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
        target = best_group(groups, skill)
        if skill.islower() and _kind(skill) == "concept":
            skill = " ".join(w[:1].upper() + w[1:] for w in skill.split())  # "machine learning" -> "Machine Learning"
        if target is None:
            target = {"group": "Skills", "items": []}
            groups.append(target)
        target.setdefault("items", []).append(skill)
        present.add(skill.lower())
        added.append(skill)
    return resume, added, renamed

"""Knowledge ingestion + authorized retrieval.

Retrieval authorization happens INSIDE the SQL query (visibility/owner/active-version/deleted/
review filters) — passages a user may not see never enter application memory. RLS enforces the
same rule as a second layer. Exact (sequential) cosine search is used: correct for the current
corpus size; an ANN index must be benchmarked before adoption (filters reduce ANN recall).
"""

from __future__ import annotations

import hashlib
import re
import uuid
from typing import Any

from sqlalchemy import text
from sqlalchemy.orm import Session

from ..config import get_settings
from .llm import get_provider

INGESTION_VERSION = "ingest-1"


def chunk_text(body: str, size: int | None = None, overlap: int | None = None) -> list[str]:
    s = get_settings()
    size, overlap = size or s.chunk_chars, overlap if overlap is not None else s.chunk_overlap
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    chunks: list[str] = []
    cur = ""
    for p in paras:
        while len(p) > size:
            cut = p.rfind(". ", 0, size)
            cut = cut + 1 if cut > size // 2 else size
            if cur:
                chunks.append(cur)
                cur = ""
            chunks.append(p[:cut].strip())
            p = p[max(0, cut - overlap):].strip()
        if len(cur) + len(p) + 2 <= size:
            cur = f"{cur}\n\n{p}" if cur else p
        else:
            if cur:
                chunks.append(cur)
            tail = cur[-overlap:] if overlap and cur else ""
            cur = (tail + "\n\n" + p).strip() if tail else p
    if cur:
        chunks.append(cur)
    seen: set[str] = set()
    out = []
    for c in chunks:
        h = hashlib.sha256(re.sub(r"\s+", " ", c.lower()).encode()).hexdigest()
        if h not in seen and len(c) >= 40:
            seen.add(h)
            out.append(c)
    return out


def embed_batches(texts: list[str], cancel_check: Any = None) -> list[list[float]]:
    out: list[list[float]] = []
    for i in range(0, len(texts), 16):
        if cancel_check and cancel_check():
            raise InterruptedError
        # nomic-embed-text expects task prefixes.
        out.extend(get_provider().embed([f"search_document: {t}" for t in texts[i:i + 16]]))
    return out


SEARCH_SQL = text("""
with authorized as (
  select c.id, c.text, c.ord, c.embedding, c.tsv, s.id as source_id, s.title, s.source_url, s.visibility,
         s.domain, s.review_state, s.published_on, v.version, v.retrieved_at, v.id as version_id
  from knowledge_chunks c
  join knowledge_sources s on s.id = c.source_id and s.active_version_id = c.version_id
  join knowledge_versions v on v.id = c.version_id and v.status = 'active'
  where s.deleted_at is null and s.review_state <> 'rejected' and s.language = :lang
    and (s.visibility = 'shared' or s.owner_id = :owner)
    and (cast(:domain as text) is null or s.domain is null or s.domain = :domain)
    and v.embed_model = :embed_model
)
select id, text, ord, source_id, title, source_url, visibility, domain, review_state, published_on, version,
       retrieved_at, version_id, (embedding <=> cast(:q as vector)) as distance,
       ts_rank(tsv, plainto_tsquery('english', :qtext)) as krank
from authorized
order by embedding <=> cast(:q as vector)
limit :n
""")

KEYWORD_SQL = text("""
select c.id from knowledge_chunks c
join knowledge_sources s on s.id = c.source_id and s.active_version_id = c.version_id
where s.deleted_at is null and s.review_state <> 'rejected' and s.language = :lang
  and (s.visibility = 'shared' or s.owner_id = :owner)
  and (cast(:domain as text) is null or s.domain is null or s.domain = :domain)
  and c.tsv @@ plainto_tsquery('english', :qtext)
order by ts_rank(c.tsv, plainto_tsquery('english', :qtext)) desc limit :n
""")


def search(db: Session, owner_id: uuid.UUID, query: str, *, domain: str | None = None, k: int | None = None,
           lang: str = "en") -> dict[str, Any]:
    """Hybrid search. Returns {"passages": [...], "insufficient": bool}. Never pads with irrelevant text."""
    s = get_settings()
    k = k or s.rag_top_k
    q = query.strip()[:1000]
    if not q:
        return {"passages": [], "insufficient": True}
    vec = get_provider().embed([f"search_query: {q}"])[0]
    params = {"owner": owner_id, "domain": domain, "lang": lang, "q": str(vec), "qtext": q, "n": k * 3,
              "embed_model": s.embed_model}
    rows = db.execute(SEARCH_SQL, params).mappings().all()
    kw_ids = {r[0] for r in db.execute(KEYWORD_SQL, params).all()}
    passages: list[dict[str, Any]] = []
    seen: set[str] = set()
    for r in rows:
        relevant = r["distance"] <= s.rag_max_distance or (r["id"] in kw_ids and r["distance"] <= s.rag_max_distance + 0.1)
        if not relevant:
            continue
        h = hashlib.sha256(re.sub(r"\s+", " ", r["text"].lower()).encode()).hexdigest()
        if h in seen:
            continue
        seen.add(h)
        passages.append({
            "chunk_id": str(r["id"]), "text": r["text"], "source_id": str(r["source_id"]), "title": r["title"],
            "source_url": r["source_url"], "visibility": r["visibility"], "domain": r["domain"],
            "review_state": r["review_state"], "published_on": r["published_on"], "source_version": r["version"],
            "retrieved_at": r["retrieved_at"], "distance": round(float(r["distance"]), 4),
            "keyword_match": r["id"] in kw_ids})
        if len(passages) >= k:
            break
    return {"passages": passages, "insufficient": not passages}


def verify_citations(supplied: list[dict[str, Any]], claims: list[tuple[str, str | None]]
                     ) -> tuple[list[str], list[str]]:
    """Keep only citations that (a) were supplied to the model and (b) whose passage contains the
    quoted excerpt. Returns (valid_ids, problems)."""
    by_id = {p["chunk_id"]: p for p in supplied}
    valid: list[str] = []
    problems: list[str] = []
    for cid, excerpt in claims:
        p = by_id.get(cid)
        if p is None:
            problems.append(f"Citation {cid[:8]} was not among the supplied passages and was removed.")
            continue
        if excerpt:
            norm = lambda s: re.sub(r"\W+", " ", s.lower()).strip()  # noqa: E731
            if norm(excerpt) not in norm(p["text"]):
                problems.append(f"Quoted excerpt not found in passage {cid[:8]}; citation removed.")
                continue
        valid.append(cid)
    return valid, problems

"""Job capture, identity, snapshots, and effective (corrected) analysis views."""

from __future__ import annotations

import copy
import hashlib
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from ..errors import NotFound
from ..models import Job, JobAnalysis, JobCorrection, JobSnapshot
from . import job_analysis
from . import job_text as jt
from .taxonomy import load_taxonomy


def get_job(db: Session, owner_id: uuid.UUID, job_id: uuid.UUID) -> Job:
    job = db.execute(select(Job).where(Job.id == job_id, Job.owner_id == owner_id)).scalar_one_or_none()
    if job is None:
        raise NotFound("Job not found")
    return job


def upsert_job(db: Session, owner_id: uuid.UUID, url: str | None, structured: dict[str, Any] | None,
               chash: str, title: str | None, save: bool) -> tuple[Job, bool]:
    key = jt.canonical_key(url, structured, chash)
    now = datetime.now(UTC)
    stmt = insert(Job).values(owner_id=owner_id, canonical_key=key, source_url=url, title=(title or None),
                              saved_at=now if save else None, availability="last_observed" if url else "unknown",
                              last_observed_at=now if url else None).on_conflict_do_nothing(
        constraint="uq_job_owner_key").returning(Job.id)
    new_id = db.execute(stmt).scalar()
    job = db.execute(select(Job).where(Job.owner_id == owner_id, Job.canonical_key == key)).scalar_one()
    if not new_id:
        if save and job.saved_at is None:
            job.saved_at = now
        if url:
            job.last_observed_at, job.availability = now, ("closed" if job.availability == "closed" else "last_observed")
    return job, bool(new_id)


def add_snapshot(db: Session, job: Job, *, text: str, structured: dict[str, Any] | None, url: str | None,
                 page_title: str | None, method: str) -> tuple[JobSnapshot, bool]:
    norm = jt.normalize_text(text)
    chash = jt.content_hash(norm)
    existing = db.execute(select(JobSnapshot).where(JobSnapshot.job_id == job.id, JobSnapshot.content_hash == chash)
                          ).scalar_one_or_none()
    if existing:
        return existing, False
    last = db.execute(select(JobSnapshot.version).where(JobSnapshot.job_id == job.id)
                      .order_by(JobSnapshot.version.desc()).limit(1)).scalar()
    snap = JobSnapshot(job_id=job.id, owner_id=job.owner_id, version=(last or 0) + 1, content_hash=chash,
                       capture_method=method, extraction_version=jt.EXTRACTION_VERSION, source_url=url,
                       page_title=page_title, text=norm, structured=structured)
    db.add(snap)
    db.flush()
    return snap, True


def cached_analysis(db: Session, snapshot_id: uuid.UUID) -> JobAnalysis | None:
    """Reuse only a complete analysis produced with the current prompt/schema/taxonomy/model config."""
    from ..config import get_settings
    from .llm import get_provider
    model = getattr(get_provider(), "model", get_settings().llm_model)
    return db.execute(select(JobAnalysis).where(
        JobAnalysis.snapshot_id == snapshot_id, JobAnalysis.status == "complete",
        JobAnalysis.prompt_version == job_analysis.PROMPT_VERSION,
        JobAnalysis.schema_version == job_analysis.SCHEMA_VERSION,
        JobAnalysis.taxonomy_version == load_taxonomy().version,
        JobAnalysis.model == model).order_by(JobAnalysis.created_at.desc()).limit(1)
    ).scalar_one_or_none()


def active_corrections(db: Session, job_id: uuid.UUID, analysis_id: uuid.UUID) -> list[JobCorrection]:
    return list(db.execute(select(JobCorrection).where(
        JobCorrection.job_id == job_id, JobCorrection.analysis_id == analysis_id,
        JobCorrection.superseded_at.is_(None)).order_by(JobCorrection.created_at)).scalars())


def corrections_rev(corrs: list[JobCorrection]) -> str:
    return hashlib.sha256(",".join(str(c.id) for c in corrs).encode()).hexdigest()[:16] if corrs else "none"


def effective_analysis(analysis: JobAnalysis, corrs: list[JobCorrection]) -> dict[str, Any]:
    """Original analysis with user corrections overlaid. Originals are preserved under ``original``."""
    res = copy.deepcopy(analysis.result)
    reqs = {r["key"]: r for r in res.get("requirements", [])}
    for c in corrs:
        if c.target == "field" and c.key in res.get("fields", {}):
            f = res["fields"][c.key]
            f["original"] = {"value": f.get("value"), "source": f.get("source")}
            f["value"], f["source"], f["correction_id"] = c.value.get("value"), "user_correction", str(c.id)
        elif c.target == "requirement" and c.key in reqs:
            r = reqs[c.key]
            if c.value.get("removed"):
                r["removed_by_user"] = True
            r.setdefault("original", {k: r[k] for k in ("importance", "category", "concepts", "group")})
            for k in ("importance", "category", "group"):
                if k in c.value:
                    r[k] = c.value[k]
            if "concept_ids" in c.value:
                tax = load_taxonomy()
                r["concepts"] = [{"id": cid, "label": tax.skills[cid].label} for cid in c.value["concept_ids"]
                                 if cid in tax.skills]
            r["review"], r["correction_id"] = "corrected", str(c.id)
        elif c.target == "requirement_new":
            tax = load_taxonomy()
            cids = [cid for cid in c.value.get("concept_ids", []) if cid in tax.skills]
            res.setdefault("requirements", []).append({
                "key": c.key, "text": c.value.get("text", ""), "span": None, "category": c.value.get("category", "skill"),
                "importance": c.value.get("importance", "required"),
                "concepts": [{"id": cid, "label": tax.skills[cid].label} for cid in cids],
                "group": c.value.get("group", "single" if len(cids) <= 1 else "all"), "years": None, "negated": False,
                "method": "user", "review": "user_added", "notes": [], "correction_id": str(c.id)})
        elif c.target == "confirmation" and c.key in reqs:
            reqs[c.key]["user_confirmation"] = {"met": bool(c.value.get("met")), "note": c.note,
                                                "correction_id": str(c.id)}
    return res

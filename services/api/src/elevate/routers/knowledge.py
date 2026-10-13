import hashlib
import uuid
from datetime import UTC, date, datetime
from typing import Any, Literal

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import delete, func, select

from ..config import get_settings
from ..deps import AdminCtx, Authed
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import KnowledgeChunk, KnowledgeSource, KnowledgeVersion
from ..services import operations as ops
from ..services import rag
from ..services.jobs import get_job
from ..services.taxonomy import load_taxonomy

router = APIRouter(prefix="/api/v1", tags=["knowledge"])


class SourceIn(BaseModel):
    title: str = Field(min_length=3, max_length=300)
    text: str = Field(min_length=200, max_length=400_000)
    source_type: Literal["upload", "url_supplied", "authored"] = "authored"
    source_url: str | None = Field(default=None, max_length=2000)
    domain: str | None = None
    skills: list[str] = Field(default_factory=list, max_length=30)
    license_basis: str = Field(min_length=5, max_length=1000,
                               description="Why Elevate may use this text (licence, permission, own work).")
    published_on: date | None = None

    @field_validator("source_url")
    @classmethod
    def _url(cls, v: str | None) -> str | None:
        if v and not v.startswith(("https://", "http://")):
            raise ValueError("Source URL must be http(s)")
        return v

    @field_validator("domain")
    @classmethod
    def _domain(cls, v: str | None) -> str | None:
        if v and v not in load_taxonomy().domains:
            raise ValueError("Unknown domain")
        return v

    @field_validator("skills")
    @classmethod
    def _skills(cls, v: list[str]) -> list[str]:
        bad = [s for s in v if s not in load_taxonomy().skills]
        if bad:
            raise ValueError(f"Unknown skills: {', '.join(bad)}")
        return v


def _src_out(s: KnowledgeSource, versions: list[KnowledgeVersion] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(s.id), "title": s.title, "visibility": s.visibility, "source_type": s.source_type,
        "source_url": s.source_url, "domain": s.domain, "skills": s.skills, "language": s.language,
        "license_basis": s.license_basis, "published_on": s.published_on, "review_state": s.review_state,
        "review_note": s.review_note, "active_version_id": str(s.active_version_id) if s.active_version_id else None,
        "created_at": s.created_at}
    if versions is not None:
        out["versions"] = [{"id": str(v.id), "version": v.version, "status": v.status, "error": v.error,
                            "chunk_count": v.chunk_count, "embed_model": v.embed_model, "retrieved_at": v.retrieved_at,
                            "activated_at": v.activated_at, "checksum": v.checksum[:12]} for v in versions]
    return out


def _create_version(db: Any, source: KnowledgeSource, body_text: str, owner_for_op: uuid.UUID | None,
                    idem: str | None) -> dict[str, Any]:
    checksum = hashlib.sha256(body_text.encode()).hexdigest()
    existing = db.execute(select(KnowledgeVersion).where(KnowledgeVersion.source_id == source.id,
                                                         KnowledgeVersion.checksum == checksum)).scalar_one_or_none()
    if existing and existing.status in ("active", "ingesting", "pending"):
        return {"source_id": str(source.id), "version_id": str(existing.id), "operation_id": None,
                "unchanged": True}
    if existing:  # failed/superseded identical text: retry it
        v = existing
        v.status, v.error = "pending", None
    else:
        last = db.execute(select(func.max(KnowledgeVersion.version)).where(KnowledgeVersion.source_id == source.id)).scalar()
        s = get_settings()
        v = KnowledgeVersion(source_id=source.id, version=(last or 0) + 1, checksum=checksum, status="pending",
                             embed_model=s.embed_model, embed_dim=s.embed_dim, ingestion_version=rag.INGESTION_VERSION,
                             text=body_text)
        db.add(v)
    db.flush()
    op, _ = ops.create(db, owner_for_op, "knowledge_ingest", {"source_id": str(source.id), "version_id": str(v.id)},
                       idem)
    return {"source_id": str(source.id), "version_id": str(v.id), "operation_id": str(op.id), "unchanged": False,
            "status_url": f"/api/v1/operations/{op.id}"}


# ----------------------------------------------------------------- admin: shared knowledge
@router.post("/admin/knowledge", status_code=202)
def admin_create(body: SourceIn, ctx: AdminCtx, idempotency_key: str | None = Header(default=None, max_length=120)
                 ) -> dict[str, Any]:
    db, actor = ctx
    src = KnowledgeSource(owner_id=None, visibility="shared", title=body.title, source_type=body.source_type,
                          source_url=body.source_url, domain=body.domain, skills=body.skills,
                          license_basis=body.license_basis, published_on=body.published_on)
    db.info["system"] = True  # shared rows are written under system context (admin verified above)
    db.commit()  # start a new transaction so the system flag applies
    db.add(src)
    db.flush()
    # operation is owned by the admin so they can follow its status
    out = _create_version(db, src, body.text, actor.id, idempotency_key)
    db.commit()
    return out


@router.get("/admin/knowledge")
def admin_list(ctx: AdminCtx) -> list[dict[str, Any]]:
    db, _ = ctx
    out = []
    for s in db.execute(select(KnowledgeSource).where(KnowledgeSource.visibility == "shared",
                                                      KnowledgeSource.deleted_at.is_(None))
                        .order_by(KnowledgeSource.created_at.desc())).scalars():
        vs = list(db.execute(select(KnowledgeVersion).where(KnowledgeVersion.source_id == s.id)
                             .order_by(KnowledgeVersion.version.desc())).scalars())
        out.append(_src_out(s, vs))
    return out


class ReviewIn(BaseModel):
    review_state: Literal["unreviewed", "reviewed", "rejected"]
    review_note: str = Field(min_length=3, max_length=2000, description="What was actually checked.")


@router.post("/admin/knowledge/{sid}/review")
def admin_review(sid: uuid.UUID, body: ReviewIn, ctx: AdminCtx) -> dict[str, Any]:
    db, _ = ctx
    db.info["system"] = True
    db.commit()
    s = db.execute(select(KnowledgeSource).where(KnowledgeSource.id == sid, KnowledgeSource.visibility == "shared")
                   ).scalar_one_or_none()
    if s is None:
        raise NotFound("Source not found")
    s.review_state, s.review_note = body.review_state, body.review_note
    db.commit()
    return _src_out(s)


class ReingestIn(BaseModel):
    text: str = Field(min_length=200, max_length=400_000)


@router.post("/admin/knowledge/{sid}/versions", status_code=202)
def admin_reingest(sid: uuid.UUID, body: ReingestIn, ctx: AdminCtx) -> dict[str, Any]:
    db, actor = ctx
    db.info["system"] = True
    db.commit()
    s = db.execute(select(KnowledgeSource).where(KnowledgeSource.id == sid, KnowledgeSource.visibility == "shared",
                                                 KnowledgeSource.deleted_at.is_(None))).scalar_one_or_none()
    if s is None:
        raise NotFound("Source not found")
    out = _create_version(db, s, body.text, actor.id, None)
    db.commit()
    return out


@router.delete("/admin/knowledge/{sid}", status_code=204)
def admin_delete(sid: uuid.UUID, ctx: AdminCtx) -> None:
    db, _ = ctx
    db.info["system"] = True
    db.commit()
    s = db.execute(select(KnowledgeSource).where(KnowledgeSource.id == sid, KnowledgeSource.visibility == "shared")
                   ).scalar_one_or_none()
    if s is None:
        raise NotFound("Source not found")
    s.deleted_at, s.active_version_id = datetime.now(UTC), None
    db.execute(delete(KnowledgeChunk).where(KnowledgeChunk.source_id == s.id))
    db.commit()


# ----------------------------------------------------------------- private knowledge
@router.post("/knowledge", status_code=202)
def create_private(body: SourceIn, ctx: Authed, idempotency_key: str | None = Header(default=None, max_length=120)
                   ) -> dict[str, Any]:
    db, actor = ctx
    src = KnowledgeSource(owner_id=actor.id, visibility="private", title=body.title, source_type=body.source_type,
                          source_url=body.source_url, domain=body.domain, skills=body.skills,
                          license_basis=body.license_basis, published_on=body.published_on)
    db.add(src)
    db.flush()
    out = _create_version(db, src, body.text, actor.id, idempotency_key)
    db.commit()
    return out


@router.get("/knowledge")
def list_private(ctx: Authed) -> list[dict[str, Any]]:
    db, actor = ctx
    out = []
    for s in db.execute(select(KnowledgeSource).where(KnowledgeSource.owner_id == actor.id,
                                                      KnowledgeSource.deleted_at.is_(None))
                        .order_by(KnowledgeSource.created_at.desc())).scalars():
        vs = list(db.execute(select(KnowledgeVersion).where(KnowledgeVersion.source_id == s.id)
                             .order_by(KnowledgeVersion.version.desc())).scalars())
        out.append(_src_out(s, vs))
    return out


@router.delete("/knowledge/{sid}", status_code=204)
def delete_private(sid: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    s = db.execute(select(KnowledgeSource).where(KnowledgeSource.id == sid, KnowledgeSource.owner_id == actor.id)
                   ).scalar_one_or_none()
    if s is None:
        raise NotFound("Source not found")
    db.delete(s)  # cascades versions + chunks/vectors
    db.commit()


class SearchIn(BaseModel):
    query: str = Field(min_length=2, max_length=1000)
    domain: str | None = None


@router.post("/knowledge/search")
def search(body: SearchIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    if body.domain and body.domain not in load_taxonomy().domains:
        raise ValidationFailed("Unknown domain", fields={"domain": "invalid"})
    res = rag.search(db, actor.id, body.query, domain=body.domain)
    return {**res, "note": None if res["passages"] else "No sufficiently relevant passages in the knowledge library."}


class AskIn(BaseModel):
    question: str = Field(min_length=3, max_length=1000)


@router.post("/jobs/{job_id}/ask", status_code=202)
def ask_job(job_id: uuid.UUID, body: AskIn, ctx: Authed,
            idempotency_key: str | None = Header(default=None, max_length=120)) -> dict[str, Any]:
    """Job-specific cited question answering (async)."""
    db, actor = ctx
    get_job(db, actor.id, job_id)
    op, _ = ops.create(db, actor.id, "job_qa", {"job_id": str(job_id), "question": body.question}, idempotency_key)
    db.commit()
    return {"operation_id": str(op.id), "status_url": f"/api/v1/operations/{op.id}"}


_ = Conflict

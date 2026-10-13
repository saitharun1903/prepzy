import re
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, File, Form, Header, Query, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, select, update

from ..config import get_settings
from ..deps import Authed
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import Resume, ResumeVersion
from ..services import operations as ops
from ..services import resumes as rs
from ..services.taxonomy import load_taxonomy

router = APIRouter(prefix="/api/v1/resumes", tags=["resumes"])


def _get_resume(db: Any, owner: uuid.UUID, rid: uuid.UUID) -> Resume:
    r = db.execute(select(Resume).where(Resume.id == rid, Resume.owner_id == owner)).scalar_one_or_none()
    if r is None:
        raise NotFound("Resume not found")
    return r


def _get_version(db: Any, owner: uuid.UUID, rid: uuid.UUID, vid: uuid.UUID) -> ResumeVersion:
    v = db.execute(select(ResumeVersion).where(ResumeVersion.id == vid, ResumeVersion.resume_id == rid,
                                               ResumeVersion.owner_id == owner)).scalar_one_or_none()
    if v is None:
        raise NotFound("Resume version not found")
    return v


def _version_meta(v: ResumeVersion) -> dict[str, Any]:
    return {"id": str(v.id), "version": v.version, "origin": v.origin, "original_filename": v.original_filename,
            "mime": v.mime, "size_bytes": v.size_bytes, "parse_status": v.parse_status, "parse_error": v.parse_error,
            "reviewed_at": v.reviewed_at, "created_at": v.created_at, "has_file": bool(v.storage_name),
            "skill_count": len((v.extracted or {}).get("skills", []))}


def _new_resume_or_existing(db: Any, owner: uuid.UUID, resume_id: uuid.UUID | None, name: str) -> tuple[Resume, int]:
    if resume_id:
        r = _get_resume(db, owner, resume_id)
    else:
        has_default = db.execute(select(func.count()).select_from(Resume).where(Resume.owner_id == owner,
                                                                                Resume.is_default)).scalar_one()
        r = Resume(owner_id=owner, name=name, is_default=has_default == 0)
        db.add(r)
        db.flush()
    last = db.execute(select(func.max(ResumeVersion.version)).where(ResumeVersion.resume_id == r.id)).scalar()
    return r, (last or 0) + 1


@router.get("")
def list_resumes(ctx: Authed) -> list[dict[str, Any]]:
    db, actor = ctx
    out = []
    for r in db.execute(select(Resume).where(Resume.owner_id == actor.id).order_by(Resume.created_at)).scalars():
        vs = sorted(r.versions, key=lambda v: -v.version)
        out.append({"id": str(r.id), "name": r.name, "is_default": r.is_default, "created_at": r.created_at,
                    "versions": [_version_meta(v) for v in vs]})
    return out


@router.post("/upload", status_code=202)
def upload(ctx: Authed, file: UploadFile = File(...), name: str = Form(default="", max_length=120),
           resume_id: uuid.UUID | None = Form(default=None),
           idempotency_key: str | None = Header(default=None, max_length=120)) -> dict[str, Any]:
    db, actor = ctx
    limit = get_settings().max_upload_mb * 1024 * 1024
    data = file.file.read(limit + 1)
    if len(data) > limit:
        raise ValidationFailed(f"Files are limited to {get_settings().max_upload_mb} MB.", code="file_too_large")
    if not data:
        raise ValidationFailed("The file is empty.", code="empty_file")
    fname = re.sub(r"[^\w.\- ]", "_", (file.filename or "resume"))[:200]
    kind = rs.detect_kind(data, fname)
    r, vno = _new_resume_or_existing(db, actor.id, resume_id, name.strip() or fname.rsplit(".", 1)[0][:120] or "Resume")
    storage, sha = rs.store_file(actor.id, data)
    v = ResumeVersion(resume_id=r.id, owner_id=actor.id, version=vno, origin="upload", original_filename=fname,
                      storage_name=storage, file_sha256=sha, mime=rs.SUPPORTED[kind], size_bytes=len(data),
                      parse_status="pending")
    db.add(v)
    db.flush()
    op, _ = ops.create(db, actor.id, "resume_parse", {"resume_id": str(r.id), "version_id": str(v.id), "kind": kind},
                       idempotency_key)
    db.commit()
    return {"resume_id": str(r.id), "version_id": str(v.id), "operation_id": str(op.id),
            "status_url": f"/api/v1/operations/{op.id}"}


class TextResume(BaseModel):
    name: str = Field(default="Resume", max_length=120)
    text: str = Field(min_length=100, max_length=rs.MAX_TEXT)
    resume_id: uuid.UUID | None = None
    origin: Literal["manual", "edited"] = "manual"
    based_on_version_id: uuid.UUID | None = None


@router.post("/text", status_code=201)
def create_text_version(body: TextResume, ctx: Authed) -> dict[str, Any]:
    """Manual text entry or an accepted edited draft. Always creates a NEW version; originals stay intact."""
    db, actor = ctx
    r, vno = _new_resume_or_existing(db, actor.id, body.resume_id, body.name.strip() or "Resume")
    reviewed = None
    if body.based_on_version_id:
        base = _get_version(db, actor.id, r.id, body.based_on_version_id)
        reviewed = base.reviewed
    text = body.text.replace("\r\n", "\n")
    v = ResumeVersion(resume_id=r.id, owner_id=actor.id, version=vno, origin=body.origin, text=text,
                      parse_status="parsed", extracted=rs.extract_evidence(text), parser_version=rs.PARSER_VERSION,
                      reviewed=reviewed)
    db.add(v)
    db.commit()
    return {"resume_id": str(r.id), "version_id": str(v.id)}


@router.get("/{rid}/versions/{vid}")
def get_version(rid: uuid.UUID, vid: uuid.UUID, ctx: Authed, job_id: uuid.UUID | None = None) -> dict[str, Any]:
    db, actor = ctx
    r = _get_resume(db, actor.id, rid)
    v = _get_version(db, actor.id, rid, vid)
    job_concepts = None
    if job_id and v.extracted:
        from ..models import JobAnalysis
        a = db.execute(select(JobAnalysis).where(JobAnalysis.job_id == job_id, JobAnalysis.owner_id == actor.id)
                       .order_by(JobAnalysis.created_at.desc()).limit(1)).scalar_one_or_none()
        if a:
            seen: dict[str, dict[str, Any]] = {}
            for req in a.result.get("requirements", []):
                for c in req.get("concepts", []):
                    seen[c["id"]] = c
            job_concepts = list(seen.values())
    return {"resume": {"id": str(r.id), "name": r.name, "is_default": r.is_default},
            "version": {**_version_meta(v), "text": v.text, "extracted": v.extracted, "reviewed": v.reviewed,
                        "effective_skills": list(rs.effective_skills(v.extracted, v.reviewed).values())},
            "ats_findings": rs.ats_findings(v.text or "", v.extracted, job_concepts) if v.extracted else []}


class Review(BaseModel):
    removed_skills: list[str] = Field(default_factory=list, max_length=200)
    added_skills: list[dict[str, str]] = Field(default_factory=list, max_length=200)
    experience_months_override: int | None = Field(default=None, ge=0, le=720)
    expected_reviewed_at: datetime | None = None


@router.put("/{rid}/versions/{vid}/review")
def save_review(rid: uuid.UUID, vid: uuid.UUID, body: Review, ctx: Authed) -> dict[str, Any]:
    """User corrections to extracted evidence, stored separately from the original extraction."""
    db, actor = ctx
    v = _get_version(db, actor.id, rid, vid)
    if body.expected_reviewed_at is not None and v.reviewed_at is not None and \
            abs((v.reviewed_at - body.expected_reviewed_at).total_seconds()) > 0.001:
        raise Conflict("This review was changed elsewhere. Reload to see the latest version.", code="stale_write")
    tax = load_taxonomy()
    for a in body.added_skills:
        if a.get("id") not in tax.skills:
            raise ValidationFailed(f"Unknown skill: {a.get('id')}", fields={"added_skills": "unknown id"})
        if a.get("evidence_type", "self_reported") not in ("self_reported", "project", "course", "professional",
                                                            "certification"):
            raise ValidationFailed("Invalid evidence type", fields={"added_skills": "invalid evidence_type"})
    v.reviewed = {"removed_skills": body.removed_skills, "added_skills": body.added_skills,
                  "experience_months_override": body.experience_months_override}
    v.reviewed_at = datetime.now(UTC)
    db.commit()
    return {"reviewed_at": v.reviewed_at}


@router.post("/{rid}/default", status_code=204)
def set_default(rid: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    r = _get_resume(db, actor.id, rid)
    db.execute(update(Resume).where(Resume.owner_id == actor.id, Resume.is_default).values(is_default=False))
    db.flush()
    r.is_default = True
    db.commit()


class RenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)


@router.patch("/{rid}", status_code=204)
def rename(rid: uuid.UUID, body: RenameIn, ctx: Authed) -> None:
    db, actor = ctx
    _get_resume(db, actor.id, rid).name = body.name.strip()
    db.commit()


def _remove_file(owner: uuid.UUID, v: ResumeVersion) -> None:
    if v.storage_name:
        rs.file_path(owner, v.storage_name).unlink(missing_ok=True)


@router.delete("/{rid}/versions/{vid}", status_code=204)
def delete_version(rid: uuid.UUID, vid: uuid.UUID, ctx: Authed) -> None:
    """Deletes this version, its stored file and match reports built from it. Other versions are kept."""
    db, actor = ctx
    r = _get_resume(db, actor.id, rid)
    v = _get_version(db, actor.id, rid, vid)
    _remove_file(actor.id, v)
    db.delete(v)
    db.flush()
    if not db.execute(select(func.count()).select_from(ResumeVersion).where(ResumeVersion.resume_id == r.id)).scalar_one():
        db.delete(r)
    db.commit()


@router.delete("/{rid}", status_code=204)
def delete_resume(rid: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    r = _get_resume(db, actor.id, rid)
    for v in r.versions:
        _remove_file(actor.id, v)
    db.delete(r)
    db.commit()


@router.get("/{rid}/versions/{vid}/file")
def download_original(rid: uuid.UUID, vid: uuid.UUID, ctx: Authed) -> FileResponse:
    db, actor = ctx
    v = _get_version(db, actor.id, rid, vid)
    if not v.storage_name:
        raise NotFound("This version has no uploaded file")
    p = rs.file_path(actor.id, v.storage_name)
    if not p.exists():
        raise NotFound("The stored file is missing")
    return FileResponse(p, media_type=v.mime or "application/octet-stream",
                        filename=v.original_filename or "resume", headers={"Cache-Control": "no-store"})


@router.get("/{rid}/versions/{vid}/export")
def export_text(rid: uuid.UUID, vid: uuid.UUID, ctx: Authed, fmt: Literal["txt", "md"] = Query("md", alias="format")
                ) -> PlainTextResponse:
    """Text export of the version content. This is NOT the original PDF/DOCX layout."""
    db, actor = ctx
    r = _get_resume(db, actor.id, rid)
    v = _get_version(db, actor.id, rid, vid)
    if not v.text:
        raise NotFound("This version has no parsed text yet")
    safe = re.sub(r"[^\w\-]", "_", r.name)[:60]
    media = "text/markdown" if fmt == "md" else "text/plain"
    return PlainTextResponse(v.text, media_type=f"{media}; charset=utf-8", headers={
        "Content-Disposition": f'attachment; filename="{safe}-v{v.version}.{fmt}"', "Cache-Control": "no-store"})


class SuggestIn(BaseModel):
    job_id: uuid.UUID | None = None


@router.post("/{rid}/versions/{vid}/suggestions", status_code=202)
def request_suggestions(rid: uuid.UUID, vid: uuid.UUID, body: SuggestIn, ctx: Authed,
                        idempotency_key: str | None = Header(default=None, max_length=120)) -> dict[str, Any]:
    db, actor = ctx
    v = _get_version(db, actor.id, rid, vid)
    if v.parse_status != "parsed":
        raise Conflict("Wait until this resume has been parsed.", code="not_parsed")
    if body.job_id:
        from ..services.jobs import get_job
        get_job(db, actor.id, body.job_id)
    op, _ = ops.create(db, actor.id, "resume_suggest", {"resume_id": str(rid), "version_id": str(vid),
                                                        "job_id": str(body.job_id) if body.job_id else None},
                       idempotency_key)
    db.commit()
    return {"operation_id": str(op.id), "status_url": f"/api/v1/operations/{op.id}"}

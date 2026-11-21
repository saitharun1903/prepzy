"""ATS score checker: score any resume file (or a saved resume) against a job, per ATS system."""

from __future__ import annotations

import uuid
from typing import Any

from fastapi import APIRouter, File, Form, Response, UploadFile
from sqlalchemy import select

from ..config import get_settings
from ..deps import Authed
from ..errors import ValidationFailed
from ..models import JobAnalysis, JobSnapshot, ResumeVersion
from ..services import ats as atsvc
from ..services import resumes as rs

router = APIRouter(prefix="/api/v1/ats", tags=["ats"])


@router.get("/systems")
def systems() -> dict[str, Any]:
    return {"items": [{"id": p.id, "name": p.name, "style": p.style} for p in atsvc.PROFILES.values()]}


@router.post("/check")
async def check(ctx: Authed, response: Response,
                file: UploadFile | None = File(default=None),
                resume_version_id: uuid.UUID | None = Form(default=None),
                job_id: uuid.UUID | None = Form(default=None),
                job_text: str = Form(default="", max_length=60_000),
                job_url: str = Form(default="", max_length=2000),
                ats: str = Form(default="auto", max_length=40)) -> dict[str, Any]:
    """Score a resume for one job. Resume: an uploaded PDF/DOCX or a saved version. Job: a saved job, pasted text,
    or a link (fetched with the same SSRF guards as job import)."""
    from ..services.account_security import rate_limit
    db, actor = ctx
    rate_limit(db, f"ats:{actor.id}", limit=20, window_seconds=60)
    response.headers["Cache-Control"] = "no-store"

    # ---- resume
    data, kind, resume_text = None, None, None
    if file is not None and file.filename:
        limit = get_settings().max_upload_mb * 1024 * 1024
        data = await file.read(limit + 1)
        if len(data) > limit:
            raise ValidationFailed(f"The file is larger than {get_settings().max_upload_mb} MB.", code="too_large")
        kind = rs.detect_kind(data, file.filename)
    elif resume_version_id:
        v = db.execute(select(ResumeVersion).where(ResumeVersion.id == resume_version_id,
                                                   ResumeVersion.owner_id == actor.id)).scalar_one_or_none()
        if v is None or not v.text:
            raise ValidationFailed("That resume wasn't found or hasn't been read yet.", fields={"resume": "Not found"})
        resume_text = v.text
        if v.storage_name and v.mime in ("application/pdf",
                                          "application/vnd.openxmlformats-officedocument.wordprocessingml.document"):
            try:  # check the real file when we have it: layout problems only show up there
                data = rs.read_file(actor.id, v.storage_name)
                kind = "pdf" if v.mime == "application/pdf" else "docx"
            except Exception:  # noqa: BLE001 - fall back to the extracted text
                data = None
    else:
        raise ValidationFailed("Upload a resume file or choose one of your resumes.", fields={"resume": "Required"})

    # ---- job
    requirements, title, url = None, None, job_url.strip() or None
    text = job_text.strip()
    if job_id:
        from ..services.jobs import active_corrections, effective_analysis, get_job
        job = get_job(db, actor.id, job_id)
        url = url or job.source_url
        title = job.title
        a = db.execute(select(JobAnalysis).where(JobAnalysis.job_id == job_id).order_by(JobAnalysis.created_at.desc())
                       .limit(1)).scalar_one_or_none()
        if a:
            eff = effective_analysis(a, active_corrections(db, job_id, a.id))
            requirements = eff.get("requirements", [])
            title = eff["fields"]["title"]["value"] or title
        snap = db.execute(select(JobSnapshot).where(JobSnapshot.job_id == job_id).order_by(JobSnapshot.captured_at.desc())
                          .limit(1)).scalar_one_or_none()
        text = text or (snap.text if snap else "")
    elif not text and url:
        from ..services.link_import import import_link
        got = import_link(url)
        text, title, url = got.text, got.title, got.url
    if len(text) < 80:
        raise ValidationFailed("Add the job: choose a saved job, paste the job description, or paste its link.",
                               fields={"job": "Required"})
    try:
        return atsvc.check(data=data, kind=kind, resume_text=resume_text, job_text=text, job_url=url,
                           requirements=requirements, ats=ats, job_title=title)
    except ValueError as e:
        raise ValidationFailed(str(e), code="unreadable_file") from e

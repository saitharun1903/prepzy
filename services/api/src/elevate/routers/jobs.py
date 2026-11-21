import base64
import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Header, Query, Response
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import and_, func, or_, select

from ..config import get_settings
from ..deps import Authed
from ..errors import NotFound, ValidationFailed
from ..models import Application, Job, JobAnalysis, JobCorrection, JobSnapshot, MatchReport
from ..services import job_text as jt
from ..services import jobs as jobsvc
from ..services import operations as ops
from ..services.taxonomy import load_taxonomy

router = APIRouter(prefix="/api/v1/jobs", tags=["jobs"])


class CaptureSource(BaseModel):
    url: str | None = Field(default=None, max_length=4000)
    page_title: str | None = Field(default=None, max_length=500)
    captured_at: datetime | None = None
    adapter: str | None = Field(default=None, max_length=40)


class CaptureIn(BaseModel):
    method: Literal["extension", "manual", "link"]
    text: str = Field(min_length=1)
    title: str | None = Field(default=None, max_length=300)
    company: str | None = Field(default=None, max_length=300)
    source: CaptureSource = CaptureSource()
    structured: dict[str, Any] | None = None
    save: bool = False

    @field_validator("structured")
    @classmethod
    def _limit_structured(cls, v: dict[str, Any] | None) -> dict[str, Any] | None:
        import json
        if v is not None and len(json.dumps(v)) > 50_000:
            raise ValueError("Structured data too large")
        return v


class CaptureOut(BaseModel):
    job_id: str
    snapshot_id: str
    operation_id: str | None
    analysis_id: str | None
    reused_analysis: bool
    new_job: bool
    status_url: str | None


@router.post("/capture", response_model=CaptureOut, status_code=202)
def capture(body: CaptureIn, ctx: Authed, response: Response,
            idempotency_key: str | None = Header(default=None, max_length=120)) -> CaptureOut:
    """Accept job text (from the extension or manual entry), persist job+snapshot, and queue analysis.
    202 means *accepted*, not analysed. Poll status_url."""
    db, actor = ctx
    return _capture(db, actor, body, response, idempotency_key)


def _capture(db: Any, actor: Any, body: CaptureIn, response: Response, idempotency_key: str | None) -> CaptureOut:
    s = get_settings()
    text = jt.normalize_text(body.text)
    if len(text) < 80:
        raise ValidationFailed("The job text is too short to analyse (minimum 80 characters).",
                               fields={"text": "Too short"})
    if len(text) > s.max_job_text_chars:
        raise ValidationFailed(f"The job text exceeds {s.max_job_text_chars} characters.", fields={"text": "Too long"})
    url = jt.normalize_url(body.source.url) if body.source.url else None
    if body.source.url and url is None:
        raise ValidationFailed("Only http(s) page URLs are accepted.", fields={"source.url": "Unsupported URL"})
    chash = jt.content_hash(text)
    job, new_job = jobsvc.upsert_job(db, actor.id, body.source.url, body.structured, chash, body.title, body.save)
    if body.company and not job.company:
        job.company = body.company[:300]
    snap, _ = jobsvc.add_snapshot(db, job, text=text, structured=body.structured, url=body.source.url,
                                  page_title=body.source.page_title, method=body.method)
    cached = jobsvc.cached_analysis(db, snap.id)
    if cached:
        db.commit()
        response.status_code = 200
        return CaptureOut(job_id=str(job.id), snapshot_id=str(snap.id), operation_id=None, analysis_id=str(cached.id),
                          reused_analysis=True, new_job=new_job, status_url=None)
    op, _ = ops.create(db, actor.id, "job_analysis", {"job_id": str(job.id), "snapshot_id": str(snap.id)},
                       idempotency_key)
    db.commit()
    return CaptureOut(job_id=str(job.id), snapshot_id=str(snap.id), operation_id=str(op.id), analysis_id=None,
                      reused_analysis=False, new_job=new_job, status_url=f"/api/v1/operations/{op.id}")


class LinkIn(BaseModel):
    url: str = Field(min_length=4, max_length=2000)
    save: bool = True


@router.post("/import-link", response_model=CaptureOut, status_code=202)
def import_link(body: LinkIn, ctx: Authed, response: Response,
                idempotency_key: str | None = Header(default=None, max_length=120)) -> CaptureOut:
    """Fetch a public job posting from a link (LinkedIn, Naukri, Indeed, company/ATS pages), then capture and
    analyse it exactly like pasted text. The fetch is SSRF-guarded; see services/link_import.py."""
    from ..services.account_security import rate_limit
    from ..services.link_import import import_link as fetch_link
    db, actor = ctx
    rate_limit(db, f"link-import:{actor.id}", limit=12, window_seconds=60)
    db.commit()
    got = fetch_link(body.url)
    cap = CaptureIn(method="link", text=got.text[: get_settings().max_job_text_chars], title=got.title,
                    company=got.company, save=body.save,
                    source=CaptureSource(url=got.url, page_title=got.title, adapter=f"link:{got.source}"))
    return _capture(db, actor, cap, response, idempotency_key)


class JobSummary(BaseModel):
    id: str
    title: str | None
    company: str | None
    source_url: str | None
    saved: bool
    saved_at: datetime | None
    created_at: datetime
    updated_at: datetime
    availability: str
    last_observed_at: datetime | None
    application_status: str | None
    latest_analysis_status: str | None
    domains: list[dict[str, Any]]


class JobPage(BaseModel):
    items: list[JobSummary]
    next_cursor: str | None
    total: int


def _enc(ts: datetime, i: uuid.UUID) -> str:
    return base64.urlsafe_b64encode(f"{ts.isoformat()}|{i}".encode()).decode()


def _dec(c: str) -> tuple[datetime, uuid.UUID]:
    try:
        ts, i = base64.urlsafe_b64decode(c.encode()).decode().split("|")
        return datetime.fromisoformat(ts), uuid.UUID(i)
    except (ValueError, UnicodeDecodeError) as e:
        raise ValidationFailed("Invalid cursor", fields={"cursor": "invalid"}) from e


@router.get("", response_model=JobPage)
def list_jobs(ctx: Authed, saved: bool | None = None, q: str | None = Query(default=None, max_length=200),
              cursor: str | None = None, limit: int = Query(default=20, ge=1, le=100)) -> JobPage:
    db, actor = ctx
    conds = [Job.owner_id == actor.id]
    if saved is True:
        conds.append(Job.saved_at.is_not(None))
    if q:
        like = f"%{q.lower()}%"
        conds.append(or_(func.lower(Job.title).like(like), func.lower(Job.company).like(like)))
    total = db.execute(select(func.count()).select_from(Job).where(*conds)).scalar_one()
    stmt = select(Job).where(*conds)
    if cursor:
        ts, cid = _dec(cursor)
        stmt = stmt.where(or_(Job.updated_at < ts, and_(Job.updated_at == ts, Job.id < cid)))
    rows = list(db.execute(stmt.order_by(Job.updated_at.desc(), Job.id.desc()).limit(limit + 1)).scalars())
    page, more = rows[:limit], len(rows) > limit
    ids = [j.id for j in page]
    apps = {a.job_id: a.status for a in db.execute(
        select(Application).where(Application.job_id.in_(ids)).order_by(Application.cycle)).scalars()}
    latest: dict[uuid.UUID, JobAnalysis] = {}
    for a in db.execute(select(JobAnalysis).where(JobAnalysis.job_id.in_(ids)).order_by(JobAnalysis.created_at)).scalars():
        latest[a.job_id] = a
    items = [JobSummary(id=str(j.id), title=j.title, company=j.company, source_url=j.source_url,
                        saved=j.saved_at is not None, saved_at=j.saved_at, created_at=j.created_at,
                        updated_at=j.updated_at, availability=j.availability, last_observed_at=j.last_observed_at,
                        application_status=apps.get(j.id),
                        latest_analysis_status=latest[j.id].status if j.id in latest else None,
                        domains=(latest[j.id].result.get("domains", []) if j.id in latest else []))
             for j in page]
    return JobPage(items=items, next_cursor=_enc(page[-1].updated_at, page[-1].id) if more else None, total=total)


@router.get("/lookup")
def lookup(ctx: Authed, url: str = Query(max_length=4000)) -> dict[str, Any]:
    """Let the extension show whether this exact page is already in the user's jobs."""
    db, actor = ctx
    n = jt.normalize_url(url)
    if not n:
        return {"job": None}
    job = db.execute(select(Job).where(Job.owner_id == actor.id, Job.canonical_key == f"url:{n}"[:600])).scalar_one_or_none()
    if job is None:
        job = db.execute(select(Job).where(Job.owner_id == actor.id, Job.source_url == url)).scalars().first()
    if job is None:
        return {"job": None}
    latest = db.execute(select(JobAnalysis).where(JobAnalysis.job_id == job.id)
                        .order_by(JobAnalysis.created_at.desc()).limit(1)).scalar_one_or_none()
    return {"job": {"id": str(job.id), "title": job.title, "company": job.company, "saved": job.saved_at is not None,
                    "latest_analysis_id": str(latest.id) if latest else None}}


def _analysis_meta(a: JobAnalysis) -> dict[str, Any]:
    return {"id": str(a.id), "status": a.status, "created_at": a.created_at, "model": a.model,
            "prompt_version": a.prompt_version, "schema_version": a.schema_version,
            "taxonomy_version": a.taxonomy_version, "snapshot_id": str(a.snapshot_id), "duration_ms": a.duration_ms,
            "issue_count": len(a.issues or [])}


@router.get("/{job_id}")
def get_job(job_id: uuid.UUID, ctx: Authed, analysis_id: uuid.UUID | None = None) -> dict[str, Any]:
    db, actor = ctx
    job = jobsvc.get_job(db, actor.id, job_id)
    snaps = list(db.execute(select(JobSnapshot).where(JobSnapshot.job_id == job.id).order_by(JobSnapshot.version.desc())).scalars())
    analyses = list(db.execute(select(JobAnalysis).where(JobAnalysis.job_id == job.id)
                               .order_by(JobAnalysis.created_at.desc())).scalars())
    selected = None
    if analysis_id:
        selected = next((a for a in analyses if a.id == analysis_id), None)
        if selected is None:
            raise NotFound("Analysis not found")
    elif analyses:
        selected = analyses[0]
    effective = None
    corrections: list[dict[str, Any]] = []
    if selected:
        corrs = jobsvc.active_corrections(db, job.id, selected.id)
        effective = jobsvc.effective_analysis(selected, corrs)
        corrections = [{"id": str(c.id), "target": c.target, "key": c.key, "value": c.value, "note": c.note,
                        "created_at": c.created_at} for c in corrs]
    active_ops = list(db.execute(select(ops.Operation).where(
        ops.Operation.owner_id == actor.id, ops.Operation.kind == "job_analysis",
        ops.Operation.state.in_(ops.ACTIVE), ops.Operation.payload["job_id"].astext == str(job.id))).scalars())
    latest_snap = snaps[0] if snaps else None
    return {
        "job": {"id": str(job.id), "title": job.title, "company": job.company, "source_url": job.source_url,
                "saved": job.saved_at is not None, "saved_at": job.saved_at, "created_at": job.created_at,
                "availability": job.availability, "last_observed_at": job.last_observed_at},
        "snapshots": [{"id": str(s.id), "version": s.version, "capture_method": s.capture_method,
                       "captured_at": s.captured_at, "source_url": s.source_url, "page_title": s.page_title,
                       "extraction_version": s.extraction_version, "chars": len(s.text)} for s in snaps],
        "latest_snapshot_text": latest_snap.text if latest_snap else None,
        "analysis": ({**_analysis_meta(selected), "issues": selected.issues, "result": effective,
                      "is_latest": selected is analyses[0],
                      "stale": bool(latest_snap and selected.snapshot_id != latest_snap.id)} if selected else None),
        "corrections": corrections,
        "history": [_analysis_meta(a) for a in analyses],
        "active_operations": [ops.to_public(o) for o in active_ops],
    }


@router.get("/{job_id}/snapshots/{snapshot_id}")
def get_snapshot(job_id: uuid.UUID, snapshot_id: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    s = db.execute(select(JobSnapshot).where(JobSnapshot.id == snapshot_id, JobSnapshot.job_id == job_id,
                                             JobSnapshot.owner_id == actor.id)).scalar_one_or_none()
    if s is None:
        raise NotFound("Snapshot not found")
    return {"id": str(s.id), "version": s.version, "text": s.text, "structured": s.structured,
            "source_url": s.source_url, "captured_at": s.captured_at, "content_hash": s.content_hash}


@router.post("/{job_id}/save", status_code=204)
def save_job(job_id: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    job = jobsvc.get_job(db, actor.id, job_id)
    if job.saved_at is None:
        job.saved_at = datetime.now(UTC)
        job.updated_at = datetime.now(UTC)
    db.commit()


@router.delete("/{job_id}/save", status_code=204)
def unsave_job(job_id: uuid.UUID, ctx: Authed) -> None:
    """Remove from saved jobs. Analyses, notes and applications are kept."""
    db, actor = ctx
    job = jobsvc.get_job(db, actor.id, job_id)
    job.saved_at = None
    job.updated_at = datetime.now(UTC)
    db.commit()


class JobPatch(BaseModel):
    availability: Literal["unknown", "last_observed", "closed"] | None = None
    title: str | None = Field(default=None, max_length=300)
    company: str | None = Field(default=None, max_length=300)


@router.patch("/{job_id}", status_code=204)
def patch_job(job_id: uuid.UUID, body: JobPatch, ctx: Authed) -> None:
    db, actor = ctx
    job = jobsvc.get_job(db, actor.id, job_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(job, k, v)
    job.updated_at = datetime.now(UTC)
    db.commit()


@router.delete("/{job_id}", status_code=204)
def delete_job(job_id: uuid.UUID, ctx: Authed) -> None:
    """Permanently delete the job with its snapshots, analyses, reports, notes, applications and reminders."""
    db, actor = ctx
    job = jobsvc.get_job(db, actor.id, job_id)
    for o in db.execute(select(ops.Operation).where(ops.Operation.owner_id == actor.id,
                                                    ops.Operation.state.in_(ops.ACTIVE),
                                                    ops.Operation.payload["job_id"].astext == str(job.id))).scalars():
        o.cancel_requested = True
        if o.state == "queued":
            o.state, o.finished_at = "cancelled", datetime.now(UTC)
    db.delete(job)
    db.commit()


@router.post("/{job_id}/reanalyze", status_code=202)
def reanalyze(job_id: uuid.UUID, ctx: Authed, idempotency_key: str | None = Header(default=None, max_length=120)
              ) -> dict[str, Any]:
    db, actor = ctx
    job = jobsvc.get_job(db, actor.id, job_id)
    snap = db.execute(select(JobSnapshot).where(JobSnapshot.job_id == job.id).order_by(JobSnapshot.version.desc())
                      .limit(1)).scalar_one_or_none()
    if snap is None:
        raise NotFound("This job has no captured text to analyse")
    op, _ = ops.create(db, actor.id, "job_analysis", {"job_id": str(job.id), "snapshot_id": str(snap.id),
                                                      "refresh": True}, idempotency_key)
    db.commit()
    return {"operation_id": str(op.id), "status_url": f"/api/v1/operations/{op.id}"}


class CorrectionIn(BaseModel):
    analysis_id: uuid.UUID
    target: Literal["field", "requirement", "requirement_new", "confirmation"]
    key: str = Field(max_length=120)
    value: dict[str, Any]
    note: str | None = Field(default=None, max_length=2000)


_FIELDS = {"title", "company", "location", "work_mode", "employment_type", "seniority", "experience", "education",
           "salary", "deadline", "posted"}


@router.post("/{job_id}/corrections", status_code=201)
def add_correction(job_id: uuid.UUID, body: CorrectionIn, ctx: Authed) -> dict[str, Any]:
    """Attributable override. The original analysis is never modified; dependent match reports become stale."""
    db, actor = ctx
    job = jobsvc.get_job(db, actor.id, job_id)
    a = db.execute(select(JobAnalysis).where(JobAnalysis.id == body.analysis_id, JobAnalysis.job_id == job.id)
                   ).scalar_one_or_none()
    if a is None:
        raise NotFound("Analysis not found")
    keys = {r["key"] for r in a.result.get("requirements", [])}
    v = body.value
    if body.target == "field":
        if body.key not in _FIELDS or not isinstance(v.get("value"), (str, type(None))) or len(str(v.get("value") or "")) > 300:
            raise ValidationFailed("Unknown field or invalid value", fields={"key": "invalid"})
    elif body.target in ("requirement", "confirmation"):
        if body.key not in keys:
            raise ValidationFailed("Unknown requirement", fields={"key": "invalid"})
        if v.get("importance") not in (None, "required", "preferred", "optional", "unclear"):
            raise ValidationFailed("Invalid importance", fields={"value.importance": "invalid"})
        if v.get("group") not in (None, "single", "any", "all"):
            raise ValidationFailed("Invalid group", fields={"value.group": "invalid"})
        if "concept_ids" in v and (not isinstance(v["concept_ids"], list) or
                                   any(c not in load_taxonomy().skills for c in v["concept_ids"])):
            raise ValidationFailed("Unknown skill id", fields={"value.concept_ids": "invalid"})
    elif body.target == "requirement_new":
        if not isinstance(v.get("text"), str) or not (3 <= len(v["text"]) <= 600):
            raise ValidationFailed("Requirement text is required", fields={"value.text": "invalid"})
        body.key = f"u{int(datetime.now(UTC).timestamp() * 1000)}"
    # Supersede an earlier correction of the same target/key (history is kept).
    for prev in db.execute(select(JobCorrection).where(
            JobCorrection.job_id == job.id, JobCorrection.analysis_id == a.id, JobCorrection.target == body.target,
            JobCorrection.key == body.key, JobCorrection.superseded_at.is_(None))).scalars():
        prev.superseded_at = datetime.now(UTC)
    c = JobCorrection(owner_id=actor.id, job_id=job.id, analysis_id=a.id, target=body.target, key=body.key,
                      value=v, note=body.note)
    db.add(c)
    if body.target == "field" and body.key in ("title", "company") and v.get("value"):
        setattr(job, body.key, v["value"][:300])
    job.updated_at = datetime.now(UTC)
    db.commit()
    return {"id": str(c.id)}


@router.delete("/{job_id}/corrections/{correction_id}", status_code=204)
def revert_correction(job_id: uuid.UUID, correction_id: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    c = db.execute(select(JobCorrection).where(JobCorrection.id == correction_id, JobCorrection.job_id == job_id,
                                               JobCorrection.owner_id == actor.id)).scalar_one_or_none()
    if c is None:
        raise NotFound("Correction not found")
    c.superseded_at = datetime.now(UTC)
    db.commit()


@router.get("/{job_id}/match-reports")
def list_job_reports(job_id: uuid.UUID, ctx: Authed) -> list[dict[str, Any]]:
    db, actor = ctx
    jobsvc.get_job(db, actor.id, job_id)
    rows = db.execute(select(MatchReport).where(MatchReport.job_id == job_id).order_by(MatchReport.created_at.desc())).scalars()
    return [{"id": str(r.id), "created_at": r.created_at, "resume_version_id": str(r.resume_version_id) if r.resume_version_id else None,
             "summary": r.result.get("summary")} for r in rows]

import hashlib
import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import select, update

from ..deps import Authed
from ..errors import ValidationFailed
from ..models import (
    Application,
    ApplicationEvent,
    AuditEvent,
    DeletionJob,
    InterviewAnswer,
    InterviewQuestion,
    InterviewSession,
    Job,
    JobAnalysis,
    JobCorrection,
    JobSnapshot,
    KnowledgeSource,
    KnowledgeVersion,
    MatchReport,
    Note,
    Notification,
    Operation,
    Profile,
    ProfileFact,
    RefreshToken,
    Reminder,
    Resume,
    ResumeVersion,
    Roadmap,
    RoadmapEvent,
    RoadmapTask,
    User,
)
from ..security import verify_password
from ..services.resumes import user_dir

router = APIRouter(prefix="/api/v1/account", tags=["account"])

EXPORT_FORMAT = "elevate-export-1"
_SKIP = {"embedding", "tsv", "password_hash", "token_hash"}


def _row(obj: Any) -> dict[str, Any]:
    return {c.key: getattr(obj, c.key) for c in obj.__table__.columns if c.key not in _SKIP}


@router.get("/export")
def export(ctx: Authed) -> Response:
    """Machine-readable export of everything this account owns, with version/provenance links
    (ids). Uploaded resume files are listed with checksums and downloadable individually."""
    db, actor = ctx
    u = db.get(User, actor.id)
    assert u is not None
    data: dict[str, Any] = {"format": EXPORT_FORMAT, "exported_at": datetime.now(UTC), "account": _row(u)}
    tables: list[tuple[str, Any, Any]] = [
        ("profile", Profile, Profile.user_id), ("profile_facts", ProfileFact, ProfileFact.owner_id),
        ("jobs", Job, Job.owner_id), ("job_snapshots", JobSnapshot, JobSnapshot.owner_id),
        ("job_analyses", JobAnalysis, JobAnalysis.owner_id), ("job_corrections", JobCorrection, JobCorrection.owner_id),
        ("resumes", Resume, Resume.owner_id), ("resume_versions", ResumeVersion, ResumeVersion.owner_id),
        ("match_reports", MatchReport, MatchReport.owner_id),
        ("interview_sessions", InterviewSession, InterviewSession.owner_id),
        ("interview_questions", InterviewQuestion, InterviewQuestion.owner_id),
        ("interview_answers", InterviewAnswer, InterviewAnswer.owner_id),
        ("roadmaps", Roadmap, Roadmap.owner_id), ("roadmap_tasks", RoadmapTask, RoadmapTask.owner_id),
        ("roadmap_events", RoadmapEvent, RoadmapEvent.owner_id), ("applications", Application, Application.owner_id),
        ("application_events", ApplicationEvent, ApplicationEvent.owner_id), ("notes", Note, Note.owner_id),
        ("reminders", Reminder, Reminder.owner_id), ("notifications", Notification, Notification.owner_id),
        ("knowledge_sources", KnowledgeSource, KnowledgeSource.owner_id),
    ]
    for name, model, col in tables:
        data[name] = [_row(r) for r in db.execute(select(model).where(col == actor.id)).scalars()]
    src_ids = [s["id"] for s in data["knowledge_sources"]]
    data["knowledge_versions"] = [_row(v) for v in db.execute(
        select(KnowledgeVersion).where(KnowledgeVersion.source_id.in_(src_ids))).scalars()] if src_ids else []
    data["files"] = [{"resume_version_id": v["id"], "filename": v["original_filename"], "sha256": v["file_sha256"],
                      "download": f"/api/v1/resumes/{v['resume_id']}/versions/{v['id']}/file"}
                     for v in data["resume_versions"] if v.get("storage_name")]
    db.add(AuditEvent(user_id=actor.id, action="account.exported"))
    db.commit()
    body = json.dumps(data, default=str, indent=1)
    return Response(body, media_type="application/json", headers={
        "Content-Disposition": f'attachment; filename="elevate-export-{datetime.now(UTC):%Y%m%d}.json"',
        "Cache-Control": "no-store"})


class DeleteIn(BaseModel):
    password: str = Field(max_length=128)
    confirm: str = Field(max_length=40)


@router.post("/delete", status_code=204)
def delete_account(body: DeleteIn, ctx: Authed) -> None:
    """Immediately revokes access, cancels pending work, deletes all owned rows (cascade: jobs,
    resumes, reports, chunks/vectors, notes, ...) and schedules durable removal of stored files."""
    db, actor = ctx
    if body.confirm != "DELETE":
        raise ValidationFailed("Type DELETE to confirm.", fields={"confirm": "Type DELETE"})
    u = db.get(User, actor.id)
    assert u is not None
    if not verify_password(u.password_hash, body.password):
        raise ValidationFailed("Password is incorrect.", fields={"password": "Incorrect password"})
    now = datetime.now(UTC)
    # 1) revoke + cancel in one transaction
    u.deleted_at, u.token_version = now, u.token_version + 1
    db.execute(update(RefreshToken).where(RefreshToken.user_id == u.id).values(revoked_at=now))
    db.execute(update(Operation).where(Operation.owner_id == u.id, Operation.state.in_(("queued", "running",
                                       "cancellation_requested"))).values(cancel_requested=True, state="cancelled",
                                                                          finished_at=now))
    subject = hashlib.sha256(str(u.id).encode()).hexdigest()
    path = str(user_dir(u.id))
    db.commit()
    # 2) delete rows (FK cascades) + durable file-cleanup job, in system context (user row is going away)
    db.info["system"] = True
    db.add(DeletionJob(subject_ref=subject, storage_path=path))
    db.add(AuditEvent(user_id=None, action="account.deleted", meta={"subject": subject[:16]}))
    db.delete(db.get(User, actor.id))
    db.commit()

import uuid
from datetime import UTC, datetime
from typing import Any, Literal

from fastapi import APIRouter, Header
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from ..deps import Authed
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import InterviewAnswer, InterviewQuestion, InterviewSession, JobAnalysis, Profile
from ..services import operations as ops
from ..services.interviews import KIND_LABELS, RUBRIC_VERSION
from ..services.jobs import get_job
from ..services.taxonomy import load_taxonomy

router = APIRouter(prefix="/api/v1/interviews", tags=["interviews"])


def allowed_kinds(domains: list[str]) -> list[str]:
    tax = load_taxonomy()
    kinds: list[str] = []
    for d in domains:
        if d in tax.domains:
            for k in tax.domains[d].interview_kinds:
                if k not in kinds:
                    kinds.append(k)
    return kinds or ["behavioral", "hr", "role_specific"]


class SessionIn(BaseModel):
    job_id: uuid.UUID | None = None
    title: str | None = Field(default=None, max_length=200)
    kinds: list[str] = Field(default_factory=list, max_length=9)
    topics: list[str] = Field(default_factory=list, max_length=10)
    difficulty: Literal["easy", "medium", "hard"] = "medium"
    count: int = Field(default=5, ge=1, le=10)
    mode: Literal["practice", "timed"] = "practice"
    minutes: int | None = Field(default=None, ge=5, le=180)


@router.get("/options")
def options(ctx: Authed, job_id: uuid.UUID | None = None) -> dict[str, Any]:
    """Question kinds permitted for the role's domains (or the user's profile domains)."""
    db, actor = ctx
    domains: list[str] = []
    if job_id:
        get_job(db, actor.id, job_id)
        a = db.execute(select(JobAnalysis).where(JobAnalysis.job_id == job_id).order_by(JobAnalysis.created_at.desc())
                       .limit(1)).scalar_one_or_none()
        if a:
            domains = [d["id"] for d in a.result.get("domains", [])]
    if not domains:
        p = db.get(Profile, actor.id)
        domains = list(p.domains) if p else []
    kinds = allowed_kinds(domains)
    return {"domains": domains, "kinds": [{"id": k, "label": KIND_LABELS.get(k, k)} for k in kinds]}


@router.post("", status_code=202)
def create_session(body: SessionIn, ctx: Authed, idempotency_key: str | None = Header(default=None, max_length=120)
                   ) -> dict[str, Any]:
    db, actor = ctx
    title = body.title
    if body.job_id:
        job = get_job(db, actor.id, body.job_id)
        title = title or f"Practice: {job.title or 'saved job'}"
    opts = options(ctx, body.job_id)
    permitted = [k["id"] for k in opts["kinds"]]
    kinds = body.kinds or permitted
    bad = [k for k in kinds if k not in permitted]
    if bad:
        raise ValidationFailed(f"Question kinds not relevant to this role: {', '.join(bad)}", fields={"kinds": "invalid"})
    s = InterviewSession(owner_id=actor.id, job_id=body.job_id, title=title or "Practice interview",
                         config={"kinds": kinds, "topics": body.topics, "difficulty": body.difficulty,
                                 "count": body.count, "mode": body.mode, "minutes": body.minutes,
                                 "domains": opts["domains"], "rubric_version": RUBRIC_VERSION})
    db.add(s)
    db.flush()
    op, _ = ops.create(db, actor.id, "interview_generate", {"session_id": str(s.id)}, idempotency_key)
    s.config = {**s.config, "operation_id": str(op.id)}
    db.commit()
    return {"session_id": str(s.id), "operation_id": str(op.id), "status_url": f"/api/v1/operations/{op.id}"}


def _get_session(db: Any, owner: uuid.UUID, sid: uuid.UUID) -> InterviewSession:
    s = db.execute(select(InterviewSession).where(InterviewSession.id == sid, InterviewSession.owner_id == owner)
                   ).scalar_one_or_none()
    if s is None:
        raise NotFound("Interview session not found")
    return s


@router.get("")
def list_sessions(ctx: Authed) -> list[dict[str, Any]]:
    db, actor = ctx
    rows = db.execute(select(InterviewSession).where(InterviewSession.owner_id == actor.id)
                      .order_by(InterviewSession.created_at.desc()).limit(100)).scalars().all()
    ids = [s.id for s in rows]
    counts = {sid: (n, a) for sid, n, a in db.execute(
        select(InterviewQuestion.session_id, func.count(), func.count().filter(InterviewQuestion.status == "answered"))
        .where(InterviewQuestion.session_id.in_(ids)).group_by(InterviewQuestion.session_id)).all()} if ids else {}
    return [{"id": str(s.id), "title": s.title, "job_id": str(s.job_id) if s.job_id else None, "status": s.status,
             "config": s.config, "created_at": s.created_at, "completed_at": s.completed_at,
             "questions": counts.get(s.id, (0, 0))[0], "answered": counts.get(s.id, (0, 0))[1]} for s in rows]


@router.get("/{sid}")
def get_session(sid: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    s = _get_session(db, actor.id, sid)
    qs = list(db.execute(select(InterviewQuestion).where(InterviewQuestion.session_id == s.id)
                         .order_by(InterviewQuestion.ord)).scalars())
    answers: dict[uuid.UUID, list[InterviewAnswer]] = {}
    for a in db.execute(select(InterviewAnswer).where(InterviewAnswer.question_id.in_([q.id for q in qs]))
                        .order_by(InterviewAnswer.revision)).scalars():
        answers.setdefault(a.question_id, []).append(a)
    return {"id": str(s.id), "title": s.title, "job_id": str(s.job_id) if s.job_id else None, "status": s.status,
            "config": s.config, "created_at": s.created_at, "completed_at": s.completed_at,
            "questions": [{"id": str(q.id), "ord": q.ord, "kind": q.kind, "kind_label": KIND_LABELS.get(q.kind, q.kind),
                           "topic": q.topic, "prompt": q.prompt, "rubric": q.rubric, "rubric_version": q.rubric_version,
                           "origin": q.origin, "requirement_ref": q.requirement_ref, "status": q.status,
                           "answers": [{"id": str(a.id), "revision": a.revision, "answer": a.answer,
                                        "started_at": a.started_at, "submitted_at": a.submitted_at,
                                        "eval_status": a.eval_status, "evaluation": a.evaluation}
                                       for a in answers.get(q.id, [])]} for q in qs]}


class AnswerIn(BaseModel):
    answer: str = Field(min_length=1, max_length=12000)
    started_at: datetime | None = None


@router.post("/{sid}/questions/{qid}/answers", status_code=202)
def submit_answer(sid: uuid.UUID, qid: uuid.UUID, body: AnswerIn, ctx: Authed,
                  idempotency_key: str | None = Header(default=None, max_length=120)) -> dict[str, Any]:
    db, actor = ctx
    s = _get_session(db, actor.id, sid)
    if s.status not in ("active", "paused", "completed"):
        raise Conflict("This session is not ready for answers.", code="session_not_active")
    q = db.execute(select(InterviewQuestion).where(InterviewQuestion.id == qid, InterviewQuestion.session_id == s.id)
                   .with_for_update()).scalar_one_or_none()
    if q is None:
        raise NotFound("Question not found")
    rev = (db.execute(select(func.max(InterviewAnswer.revision)).where(InterviewAnswer.question_id == q.id)).scalar() or 0) + 1
    a = InterviewAnswer(question_id=q.id, owner_id=actor.id, revision=rev, answer=body.answer, started_at=body.started_at)
    db.add(a)
    q.status = "answered"
    if s.status == "paused":
        s.status = "active"
    db.flush()
    op, _ = ops.create(db, actor.id, "answer_evaluate", {"answer_id": str(a.id)}, idempotency_key)
    db.commit()
    return {"answer_id": str(a.id), "revision": rev, "operation_id": str(op.id),
            "status_url": f"/api/v1/operations/{op.id}"}


@router.post("/{sid}/questions/{qid}/skip", status_code=204)
def skip(sid: uuid.UUID, qid: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    s = _get_session(db, actor.id, sid)
    q = db.execute(select(InterviewQuestion).where(InterviewQuestion.id == qid, InterviewQuestion.session_id == s.id)
                   ).scalar_one_or_none()
    if q is None:
        raise NotFound("Question not found")
    if q.status == "pending":
        q.status = "skipped"
    db.commit()


class SessionAction(BaseModel):
    action: Literal["pause", "resume", "complete"]


@router.post("/{sid}/status")
def session_status(sid: uuid.UUID, body: SessionAction, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    s = _get_session(db, actor.id, sid)
    transitions = {("active", "pause"): "paused", ("paused", "resume"): "active", ("active", "complete"): "completed",
                   ("paused", "complete"): "completed", ("completed", "resume"): "active"}
    new = transitions.get((s.status, body.action))
    if new is None:
        raise Conflict(f"Cannot {body.action} a session that is {s.status}.", code="invalid_transition")
    s.status = new
    s.completed_at = datetime.now(UTC) if new == "completed" else None
    db.commit()
    return {"status": s.status}


@router.delete("/{sid}", status_code=204)
def delete_session(sid: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    db.delete(_get_session(db, actor.id, sid))
    db.commit()

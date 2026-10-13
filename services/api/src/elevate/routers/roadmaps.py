import uuid
from datetime import UTC, date, datetime
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import select

from ..deps import Authed
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import KnowledgeSource, MatchReport, Profile, ProfileFact, ResumeVersion, Roadmap, RoadmapEvent, RoadmapTask
from ..services import roadmap as planner
from ..services.jobs import get_job
from ..services.resumes import effective_skills

router = APIRouter(prefix="/api/v1/roadmaps", tags=["roadmaps"])


def _resources(db: Any, owner: uuid.UUID, skill_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    out: dict[str, list[dict[str, Any]]] = {}
    if not skill_ids:
        return out
    rows = db.execute(select(KnowledgeSource).where(
        KnowledgeSource.deleted_at.is_(None), KnowledgeSource.active_version_id.is_not(None),
        KnowledgeSource.review_state != "rejected", KnowledgeSource.skills.overlap(skill_ids),
        (KnowledgeSource.visibility == "shared") | (KnowledgeSource.owner_id == owner))).scalars()
    for s in rows:
        for sid in s.skills:
            if sid in skill_ids:
                out.setdefault(sid, []).append({
                    "kind": "knowledge_source", "source_id": str(s.id), "title": s.title, "url": s.source_url,
                    "review_state": s.review_state, "visibility": s.visibility,
                    "provenance": s.license_basis[:200]})
    return out


def _evidence_for_inputs(db: Any, owner: uuid.UUID, report: MatchReport | None) -> set[str]:
    ev: set[str] = {f.concept_id for f in db.execute(select(ProfileFact).where(ProfileFact.owner_id == owner,
                                                                               ProfileFact.kind == "skill")).scalars()
                    if f.concept_id}
    if report and report.resume_version_id:
        v = db.get(ResumeVersion, report.resume_version_id)
        if v:
            ev |= set(effective_skills(v.extracted, v.reviewed))
    return ev


def _build(db: Any, owner: uuid.UUID, job_id: uuid.UUID | None, weekly_hours: int, start: date,
           target: date | None) -> tuple[dict[str, Any], MatchReport | None, bool]:
    report = None
    if job_id:
        report = db.execute(select(MatchReport).where(MatchReport.job_id == job_id, MatchReport.owner_id == owner)
                            .order_by(MatchReport.created_at.desc()).limit(1)).scalar_one_or_none()
    evidenced = _evidence_for_inputs(db, owner, report)
    generic = False
    if report and report.result.get("priorities"):
        priorities = report.result["priorities"]
    elif report:
        priorities = []
    else:
        prof = db.get(Profile, owner)
        if not prof or not prof.domains:
            raise Conflict("Compare a job with your resume first, or choose target domains in your profile for a "
                           "generic starter plan.", code="insufficient_profile")
        priorities = [p for p in planner.generic_priorities(list(prof.domains)) if p["concept_id"] not in evidenced]
        generic = True
    ids = [p["concept_id"] for p in priorities]
    from ..services.taxonomy import load_taxonomy
    tax = load_taxonomy()
    all_ids = set(ids)
    for i in ids:
        all_ids |= set(tax.skills[i].prereqs) if i in tax.skills else set()
    plan = planner.plan(priorities, evidenced, weekly_hours, start, target, _resources(db, owner, list(all_ids)))
    return plan, report, generic


class RoadmapIn(BaseModel):
    job_id: uuid.UUID | None = None
    title: str | None = Field(default=None, max_length=200)
    weekly_hours: int | None = Field(default=None, ge=1, le=60)
    target_date: date | None = None


def _out(db: Any, r: Roadmap) -> dict[str, Any]:
    tasks = list(db.execute(select(RoadmapTask).where(RoadmapTask.roadmap_id == r.id).order_by(RoadmapTask.ord)).scalars())
    events = list(db.execute(select(RoadmapEvent).where(RoadmapEvent.roadmap_id == r.id)
                             .order_by(RoadmapEvent.created_at.desc()).limit(50)).scalars())
    done = sum(1 for t in tasks if t.status == "done")
    return {"id": str(r.id), "title": r.title, "job_id": str(r.job_id) if r.job_id else None, "status": r.status,
            "weekly_hours": r.weekly_hours, "start_date": r.start_date, "target_date": r.target_date,
            "feasibility": r.feasibility, "generic": r.generic, "revision": r.revision, "created_at": r.created_at,
            "updated_at": r.updated_at, "progress": {"done": done, "total": len(tasks)},
            "planner_version": planner.PLANNER_VERSION,
            "tasks": [_task_out(t) for t in tasks],
            "history": [{"kind": e.kind, "detail": e.detail, "at": e.created_at} for e in events]}


def _task_out(t: RoadmapTask) -> dict[str, Any]:
    return {"id": str(t.id), "key": t.key, "ord": t.ord, "title": t.title, "objective": t.objective,
            "skill_id": t.skill_id, "requirement_ref": t.requirement_ref, "priority": t.priority,
            "est_hours_low": t.est_hours_low, "est_hours_high": t.est_hours_high, "depends_on": t.depends_on,
            "resources": t.resources, "scheduled_week": t.scheduled_week, "status": t.status,
            "user_edited": t.user_edited, "completed_at": t.completed_at, "version": t.version}


def _insert_tasks(db: Any, r: Roadmap, tasks: list[dict[str, Any]]) -> None:
    for t in tasks:
        db.add(RoadmapTask(roadmap_id=r.id, owner_id=r.owner_id, key=t["key"], ord=t["ord"], title=t["title"],
                           objective=t["objective"], skill_id=t["skill_id"], requirement_ref=t["requirement_ref"],
                           priority=t["priority"], est_hours_low=t["est_hours_low"], est_hours_high=t["est_hours_high"],
                           depends_on=t["depends_on"], resources=t["resources"], scheduled_week=t.get("scheduled_week")))


@router.post("", status_code=201)
def create_roadmap(body: RoadmapIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    title = body.title
    if body.job_id:
        job = get_job(db, actor.id, body.job_id)
        title = title or f"Preparation: {job.title or 'saved job'}"
    prof = db.get(Profile, actor.id)
    hours = body.weekly_hours or (prof.weekly_hours if prof and prof.weekly_hours else None)
    if not hours:
        raise ValidationFailed("How many hours a week can you study? Set it here or in your profile.",
                               fields={"weekly_hours": "required"})
    target = body.target_date or (prof.target_date if prof else None)
    start = date.today()
    if target and target <= start:
        raise ValidationFailed("Target date must be in the future.", fields={"target_date": "past"})
    plan, report, generic = _build(db, actor.id, body.job_id, hours, start, target)
    if not plan["tasks"]:
        raise Conflict("Your evidence already covers the identified requirements — nothing to plan. "
                       "Practice interviews instead, or add requirements.", code="nothing_to_plan")
    r = Roadmap(owner_id=actor.id, job_id=body.job_id, match_report_id=report.id if report else None,
                title=(title or "Starter plan") + (" (generic starter)" if generic else ""), weekly_hours=hours,
                start_date=start, target_date=target, feasibility={**plan["feasibility"], "cycles": plan["cycles"]},
                generic=generic)
    db.add(r)
    db.flush()
    _insert_tasks(db, r, plan["tasks"])
    db.add(RoadmapEvent(roadmap_id=r.id, owner_id=actor.id, kind="created",
                        detail={"tasks": len(plan["tasks"]), "generic": generic,
                                "match_report_id": str(report.id) if report else None}))
    db.commit()
    return _out(db, r)


@router.get("")
def list_roadmaps(ctx: Authed) -> list[dict[str, Any]]:
    db, actor = ctx
    out = []
    for r in db.execute(select(Roadmap).where(Roadmap.owner_id == actor.id).order_by(Roadmap.updated_at.desc())).scalars():
        tasks = list(db.execute(select(RoadmapTask.status).where(RoadmapTask.roadmap_id == r.id)).scalars())
        out.append({"id": str(r.id), "title": r.title, "status": r.status, "job_id": str(r.job_id) if r.job_id else None,
                    "generic": r.generic, "progress": {"done": tasks.count("done"), "total": len(tasks)},
                    "feasible": r.feasibility.get("feasible"), "updated_at": r.updated_at})
    return out


def _get(db: Any, owner: uuid.UUID, rid: uuid.UUID, lock: bool = False) -> Roadmap:
    stmt = select(Roadmap).where(Roadmap.id == rid, Roadmap.owner_id == owner)
    r = db.execute(stmt.with_for_update() if lock else stmt).scalar_one_or_none()
    if r is None:
        raise NotFound("Roadmap not found")
    return r


@router.get("/{rid}")
def get_roadmap(rid: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    return _out(db, _get(db, actor.id, rid))


def _reschedule(db: Any, r: Roadmap) -> None:
    tasks = list(db.execute(select(RoadmapTask).where(RoadmapTask.roadmap_id == r.id).order_by(RoadmapTask.ord)).scalars())
    dicts = [_task_out(t) for t in tasks]
    res = planner.schedule(dicts, r.weekly_hours, date.today(), r.target_date)
    for t, d in zip(tasks, res["tasks"], strict=True):
        t.scheduled_week = d.get("scheduled_week")
    r.feasibility = {**res["feasibility"], "cycles": r.feasibility.get("cycles", [])}


class RoadmapPatch(BaseModel):
    expected_revision: int
    status: Literal["active", "paused", "archived"] | None = None
    weekly_hours: int | None = Field(default=None, ge=1, le=60)
    target_date: date | None = None
    clear_target_date: bool = False
    title: str | None = Field(default=None, max_length=200)


@router.patch("/{rid}")
def patch_roadmap(rid: uuid.UUID, body: RoadmapPatch, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    r = _get(db, actor.id, rid, lock=True)
    if r.revision != body.expected_revision:
        raise Conflict("This plan changed elsewhere. Reload and try again.", code="stale_write")
    changes: dict[str, Any] = {}
    if body.status and body.status != r.status:
        changes["status"] = [r.status, body.status]
        r.status = body.status
    if body.title:
        r.title = body.title
    resched = False
    if body.weekly_hours and body.weekly_hours != r.weekly_hours:
        changes["weekly_hours"] = [r.weekly_hours, body.weekly_hours]
        r.weekly_hours, resched = body.weekly_hours, True
    if body.clear_target_date and r.target_date:
        changes["target_date"] = [str(r.target_date), None]
        r.target_date, resched = None, True
    elif body.target_date and body.target_date != r.target_date:
        if body.target_date <= date.today():
            raise ValidationFailed("Target date must be in the future.", fields={"target_date": "past"})
        changes["target_date"] = [str(r.target_date), str(body.target_date)]
        r.target_date, resched = body.target_date, True
    if resched:
        _reschedule(db, r)
    r.revision += 1
    r.updated_at = datetime.now(UTC)
    if changes:
        db.add(RoadmapEvent(roadmap_id=r.id, owner_id=actor.id, kind="updated", detail=changes))
    db.commit()
    return _out(db, r)


class TaskPatch(BaseModel):
    expected_version: int
    status: Literal["todo", "in_progress", "done", "skipped"] | None = None
    title: str | None = Field(default=None, max_length=300)
    objective: str | None = Field(default=None, max_length=4000)
    est_hours_low: float | None = Field(default=None, ge=0.5, le=500)
    est_hours_high: float | None = Field(default=None, ge=0.5, le=500)


@router.patch("/{rid}/tasks/{tid}")
def patch_task(rid: uuid.UUID, tid: uuid.UUID, body: TaskPatch, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    r = _get(db, actor.id, rid, lock=True)
    t = db.execute(select(RoadmapTask).where(RoadmapTask.id == tid, RoadmapTask.roadmap_id == r.id).with_for_update()
                   ).scalar_one_or_none()
    if t is None:
        raise NotFound("Task not found")
    if t.version != body.expected_version:
        raise Conflict("This task changed elsewhere. Reload and try again.", code="stale_write")
    detail: dict[str, Any] = {"task": t.key}
    if body.status and body.status != t.status:
        if body.status == "done":
            blockers = [d for d in t.depends_on if db.execute(select(RoadmapTask.status).where(
                RoadmapTask.roadmap_id == r.id, RoadmapTask.key == d)).scalar() not in ("done", "skipped", None)]
            detail["unfinished_prerequisites"] = blockers
        detail["status"] = [t.status, body.status]
        t.status = body.status
        t.completed_at = datetime.now(UTC) if body.status == "done" else None
    edited = False
    for k in ("title", "objective", "est_hours_low", "est_hours_high"):
        v = getattr(body, k)
        if v is not None and v != getattr(t, k):
            setattr(t, k, v)
            edited = True
    if t.est_hours_high < t.est_hours_low:
        raise ValidationFailed("High estimate must be at least the low estimate.", fields={"est_hours_high": "invalid"})
    if edited:
        t.user_edited = True
        detail["edited"] = True
    t.version += 1
    if edited or body.status:
        _reschedule(db, r)
    r.updated_at = datetime.now(UTC)
    r.revision += 1
    db.add(RoadmapEvent(roadmap_id=r.id, owner_id=actor.id, kind="task_updated", detail=detail))
    db.commit()
    return _out(db, r)


class TaskIn(BaseModel):
    title: str = Field(min_length=2, max_length=300)
    objective: str | None = Field(default=None, max_length=4000)
    est_hours_low: float = Field(default=2, ge=0.5, le=500)
    est_hours_high: float = Field(default=4, ge=0.5, le=500)


@router.post("/{rid}/tasks", status_code=201)
def add_task(rid: uuid.UUID, body: TaskIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    r = _get(db, actor.id, rid, lock=True)
    last = db.execute(select(RoadmapTask.ord).where(RoadmapTask.roadmap_id == r.id).order_by(RoadmapTask.ord.desc())
                      .limit(1)).scalar() or 0
    db.add(RoadmapTask(roadmap_id=r.id, owner_id=actor.id, key=f"user:{uuid.uuid4().hex[:8]}", ord=last + 1,
                       title=body.title, objective=body.objective, priority="medium", est_hours_low=body.est_hours_low,
                       est_hours_high=max(body.est_hours_low, body.est_hours_high), user_edited=True, resources=[]))
    db.flush()
    _reschedule(db, r)
    r.revision += 1
    r.updated_at = datetime.now(UTC)
    db.add(RoadmapEvent(roadmap_id=r.id, owner_id=actor.id, kind="task_added", detail={"title": body.title}))
    db.commit()
    return _out(db, r)


@router.delete("/{rid}/tasks/{tid}")
def delete_task(rid: uuid.UUID, tid: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    r = _get(db, actor.id, rid, lock=True)
    t = db.execute(select(RoadmapTask).where(RoadmapTask.id == tid, RoadmapTask.roadmap_id == r.id)).scalar_one_or_none()
    if t is None:
        raise NotFound("Task not found")
    db.delete(t)
    db.flush()
    _reschedule(db, r)
    r.revision += 1
    db.add(RoadmapEvent(roadmap_id=r.id, owner_id=actor.id, kind="task_removed", detail={"task": t.key}))
    db.commit()
    return _out(db, r)


@router.post("/{rid}/regenerate/preview")
def regenerate_preview(rid: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    r = _get(db, actor.id, rid)
    plan, report, _ = _build(db, actor.id, r.job_id, r.weekly_hours, date.today(), r.target_date)
    current = [_task_out(t) for t in db.execute(select(RoadmapTask).where(RoadmapTask.roadmap_id == r.id)).scalars()]
    diff = planner.merge_regeneration(current, plan["tasks"])
    return {"based_on_revision": r.revision, "match_report_id": str(report.id) if report else None, "diff": diff}


class ApplyIn(BaseModel):
    expected_revision: int


@router.post("/{rid}/regenerate/apply")
def regenerate_apply(rid: uuid.UUID, body: ApplyIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    r = _get(db, actor.id, rid, lock=True)
    if r.revision != body.expected_revision:
        raise Conflict("The plan changed since the preview. Preview again.", code="stale_write")
    plan, report, _ = _build(db, actor.id, r.job_id, r.weekly_hours, date.today(), r.target_date)
    tasks = {t.key: t for t in db.execute(select(RoadmapTask).where(RoadmapTask.roadmap_id == r.id)).scalars()}
    diff = planner.merge_regeneration([_task_out(t) for t in tasks.values()], plan["tasks"])
    prop = {t["key"]: t for t in plan["tasks"]}
    for item in diff["remove"]:
        db.delete(tasks[item["key"]])
    for item in diff["update"]:
        tasks[item["key"]].priority = prop[item["key"]]["priority"]
    base_ord = max([t.ord for t in tasks.values()] or [0]) + 1
    new = [dict(prop[i["key"]], ord=base_ord + n) for n, i in enumerate(diff["add"])]
    _insert_tasks(db, r, new)
    db.flush()
    _reschedule(db, r)
    r.match_report_id = report.id if report else r.match_report_id
    r.revision += 1
    r.updated_at = datetime.now(UTC)
    db.add(RoadmapEvent(roadmap_id=r.id, owner_id=actor.id, kind="regenerated",
                        detail={k: len(v) for k, v in diff.items()}))
    db.commit()
    return _out(db, r)


@router.delete("/{rid}", status_code=204)
def delete_roadmap(rid: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    db.delete(_get(db, actor.id, rid))
    db.commit()

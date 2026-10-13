import base64
import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Any, Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Query
from fastapi.responses import Response
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import and_, func, or_, select

from ..deps import Authed
from ..errors import Conflict, NotFound, ValidationFailed
from ..models import Application, ApplicationEvent, Job, Note, Reminder, ResumeVersion
from ..services.jobs import get_job

router = APIRouter(prefix="/api/v1", tags=["applications"])

Status = Literal["planned", "applied", "screening", "interviewing", "offer", "rejected", "withdrawn", "closed"]
ORDER = ["planned", "applied", "screening", "interviewing", "offer"]
ENDED = {"rejected", "withdrawn", "closed"}
STATUS_HELP = {
    "planned": "You intend to apply; nothing has been submitted.",
    "applied": "You submitted an application (recorded by you).",
    "screening": "The employer is reviewing / an initial screen is scheduled.",
    "interviewing": "You are in interview rounds.",
    "offer": "You received an offer.",
    "rejected": "The employer declined.",
    "withdrawn": "You withdrew.",
    "closed": "The process ended for another reason (e.g. posting closed).",
}


def is_forward(a: str, b: str) -> bool:
    if b in ENDED:
        return a not in ENDED
    if a in ORDER and b in ORDER:
        return ORDER.index(b) > ORDER.index(a)
    return False


def _app_out(a: Application, job: Job | None = None, events: list[ApplicationEvent] | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {
        "id": str(a.id), "job_id": str(a.job_id), "cycle": a.cycle, "status": a.status, "applied_on": a.applied_on,
        "resume_version_id": str(a.resume_version_id) if a.resume_version_id else None, "next_action": a.next_action,
        "next_action_on": a.next_action_on, "version": a.version, "created_at": a.created_at, "updated_at": a.updated_at}
    if job is not None:
        out["job"] = {"id": str(job.id), "title": job.title, "company": job.company, "source_url": job.source_url}
    if events is not None:
        out["history"] = [{"id": str(e.id), "from": e.from_status, "to": e.to_status, "note": e.note,
                           "is_correction": e.is_correction, "at": e.occurred_at} for e in events]
    return out


class ApplicationIn(BaseModel):
    job_id: uuid.UUID
    status: Status = "planned"
    applied_on: date | None = None
    resume_version_id: uuid.UUID | None = None
    next_action: str | None = Field(default=None, max_length=300)
    next_action_on: date | None = None
    reapply: bool = False


@router.post("/applications", status_code=201)
def create_application(body: ApplicationIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    job = get_job(db, actor.id, body.job_id)
    prev = db.execute(select(Application).where(Application.owner_id == actor.id, Application.job_id == job.id)
                      .order_by(Application.cycle.desc()).limit(1).with_for_update()).scalar_one_or_none()
    if prev and (prev.status not in ENDED or not body.reapply):
        raise Conflict("An application for this job already exists." if prev.status not in ENDED else
                       "A previous application ended. Confirm that you are applying again.",
                       code="application_exists", extra={"application_id": str(prev.id)})
    if body.resume_version_id and not db.execute(select(ResumeVersion.id).where(
            ResumeVersion.id == body.resume_version_id, ResumeVersion.owner_id == actor.id)).first():
        raise NotFound("Resume version not found")
    a = Application(owner_id=actor.id, job_id=job.id, cycle=(prev.cycle + 1) if prev else 1, status=body.status,
                    applied_on=body.applied_on or (date.today() if body.status == "applied" else None),
                    resume_version_id=body.resume_version_id, next_action=body.next_action,
                    next_action_on=body.next_action_on)
    db.add(a)
    db.flush()
    db.add(ApplicationEvent(application_id=a.id, owner_id=actor.id, from_status=None, to_status=a.status,
                            note="Created"))
    if job.saved_at is None:
        job.saved_at = datetime.now(UTC)
    job.updated_at = datetime.now(UTC)
    db.commit()
    return _app_out(a, job)


@router.get("/applications")
def list_applications(ctx: Authed, status: list[Status] | None = Query(default=None),
                      q: str | None = Query(default=None, max_length=200),
                      sort: Literal["updated", "created", "next_action"] = "updated",
                      cursor: str | None = None, limit: int = Query(default=25, ge=1, le=100)) -> dict[str, Any]:
    db, actor = ctx
    conds: list[Any] = [Application.owner_id == actor.id]
    if status:
        conds.append(Application.status.in_(status))
    if q:
        like = f"%{q.lower()}%"
        conds.append(or_(func.lower(Job.title).like(like), func.lower(Job.company).like(like)))
    base = select(Application, Job).join(Job, Job.id == Application.job_id).where(*conds)
    total = db.execute(select(func.count()).select_from(base.subquery())).scalar_one()
    counts = dict(db.execute(select(Application.status, func.count()).where(Application.owner_id == actor.id)
                             .group_by(Application.status)).all())
    col = {"updated": Application.updated_at, "created": Application.created_at}.get(sort)
    if sort == "next_action":
        stmt = base.order_by(Application.next_action_on.asc().nulls_last(), Application.id)
        offset = int(cursor) if cursor and cursor.isdigit() else 0
        rows = db.execute(stmt.offset(offset).limit(limit + 1)).all()
        nxt = str(offset + limit) if len(rows) > limit else None
    else:
        assert col is not None
        stmt = base
        if cursor:
            try:
                ts_s, id_s = base64.urlsafe_b64decode(cursor).decode().split("|")
                ts, cid = datetime.fromisoformat(ts_s), uuid.UUID(id_s)
            except (ValueError, UnicodeDecodeError) as e:
                raise ValidationFailed("Invalid cursor") from e
            stmt = stmt.where(or_(col < ts, and_(col == ts, Application.id < cid)))
        rows = db.execute(stmt.order_by(col.desc(), Application.id.desc()).limit(limit + 1)).all()
        nxt = None
        if len(rows) > limit:
            last = rows[limit - 1][0]
            nxt = base64.urlsafe_b64encode(f"{getattr(last, col.key).isoformat()}|{last.id}".encode()).decode()
    return {"items": [_app_out(a, j) for a, j in rows[:limit]], "next_cursor": nxt, "total": total,
            "counts": counts, "status_help": STATUS_HELP}


def _get_app(db: Any, owner: uuid.UUID, app_id: uuid.UUID, lock: bool = False) -> Application:
    stmt = select(Application).where(Application.id == app_id, Application.owner_id == owner)
    a = db.execute(stmt.with_for_update() if lock else stmt).scalar_one_or_none()
    if a is None:
        raise NotFound("Application not found")
    return a


@router.get("/applications/{app_id}")
def get_application(app_id: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    a = _get_app(db, actor.id, app_id)
    events = list(db.execute(select(ApplicationEvent).where(ApplicationEvent.application_id == a.id)
                             .order_by(ApplicationEvent.occurred_at)).scalars())
    return _app_out(a, db.get(Job, a.job_id), events)


@router.get("/jobs/{job_id}/applications")
def job_applications(job_id: uuid.UUID, ctx: Authed) -> list[dict[str, Any]]:
    db, actor = ctx
    get_job(db, actor.id, job_id)
    out = []
    for a in db.execute(select(Application).where(Application.job_id == job_id, Application.owner_id == actor.id)
                        .order_by(Application.cycle.desc())).scalars():
        events = list(db.execute(select(ApplicationEvent).where(ApplicationEvent.application_id == a.id)
                                 .order_by(ApplicationEvent.occurred_at)).scalars())
        out.append(_app_out(a, None, events))
    return out


class ApplicationPatch(BaseModel):
    expected_version: int
    status: Status | None = None
    correction: bool = False
    note: str | None = Field(default=None, max_length=2000)
    applied_on: date | None = None
    resume_version_id: uuid.UUID | None = None
    next_action: str | None = Field(default=None, max_length=300)
    next_action_on: date | None = None
    clear_next_action: bool = False


@router.patch("/applications/{app_id}")
def update_application(app_id: uuid.UUID, body: ApplicationPatch, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    a = _get_app(db, actor.id, app_id, lock=True)
    if a.version != body.expected_version:
        raise Conflict("This application was updated elsewhere. Reload and try again.", code="stale_write",
                       extra={"current_version": a.version})
    if body.status and body.status != a.status:
        fwd = is_forward(a.status, body.status)
        if not fwd and not body.correction:
            raise Conflict(f"Moving from '{a.status}' back to '{body.status}' is a correction. Confirm it to continue.",
                           code="correction_required")
        db.add(ApplicationEvent(application_id=a.id, owner_id=actor.id, from_status=a.status, to_status=body.status,
                                note=body.note, is_correction=not fwd))
        a.status = body.status
        if body.status == "applied" and not a.applied_on:
            a.applied_on = body.applied_on or date.today()
    elif body.note:
        db.add(ApplicationEvent(application_id=a.id, owner_id=actor.id, from_status=a.status, to_status=a.status,
                                note=body.note))
    if body.applied_on:
        a.applied_on = body.applied_on
    if body.resume_version_id:
        if not db.execute(select(ResumeVersion.id).where(ResumeVersion.id == body.resume_version_id,
                                                         ResumeVersion.owner_id == actor.id)).first():
            raise NotFound("Resume version not found")
        a.resume_version_id = body.resume_version_id
    if body.clear_next_action:
        a.next_action, a.next_action_on = None, None
    if body.next_action is not None:
        a.next_action = body.next_action or None
    if body.next_action_on is not None:
        a.next_action_on = body.next_action_on
    a.version += 1
    a.updated_at = datetime.now(UTC)
    job = db.get(Job, a.job_id)
    if job:
        job.updated_at = datetime.now(UTC)
    db.commit()
    return get_application(app_id, ctx)


@router.delete("/applications/{app_id}", status_code=204)
def delete_application(app_id: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    db.delete(_get_app(db, actor.id, app_id))
    db.commit()


# ------------------------------------------------------------------ notes
class NoteIn(BaseModel):
    body: str = Field(min_length=1, max_length=20000)


class NotePatch(NoteIn):
    expected_version: int


def _note_out(n: Note) -> dict[str, Any]:
    return {"id": str(n.id), "job_id": str(n.job_id), "body": n.body, "version": n.version, "created_at": n.created_at,
            "updated_at": n.updated_at}


@router.get("/jobs/{job_id}/notes")
def list_notes(job_id: uuid.UUID, ctx: Authed) -> list[dict[str, Any]]:
    db, actor = ctx
    get_job(db, actor.id, job_id)
    return [_note_out(n) for n in db.execute(select(Note).where(Note.job_id == job_id, Note.owner_id == actor.id)
                                             .order_by(Note.created_at.desc())).scalars()]


@router.post("/jobs/{job_id}/notes", status_code=201)
def add_note(job_id: uuid.UUID, body: NoteIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    job = get_job(db, actor.id, job_id)
    n = Note(owner_id=actor.id, job_id=job.id, body=body.body)
    db.add(n)
    job.updated_at = datetime.now(UTC)
    db.commit()
    return _note_out(n)


@router.patch("/notes/{note_id}")
def edit_note(note_id: uuid.UUID, body: NotePatch, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    n = db.execute(select(Note).where(Note.id == note_id, Note.owner_id == actor.id).with_for_update()).scalar_one_or_none()
    if n is None:
        raise NotFound("Note not found")
    if n.version != body.expected_version:
        raise Conflict("This note was edited elsewhere. Copy your text, reload, and try again.", code="stale_write")
    n.body, n.version, n.updated_at = body.body, n.version + 1, datetime.now(UTC)
    db.commit()
    return _note_out(n)


@router.delete("/notes/{note_id}", status_code=204)
def delete_note(note_id: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    n = db.execute(select(Note).where(Note.id == note_id, Note.owner_id == actor.id)).scalar_one_or_none()
    if n is None:
        raise NotFound("Note not found")
    db.delete(n)
    db.commit()


# ------------------------------------------------------------------ reminders
class ReminderIn(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    job_id: uuid.UUID | None = None
    application_id: uuid.UUID | None = None
    due_at: datetime | None = None
    due_date: date | None = None
    remind_time: time = time(9, 0)
    timezone: str | None = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def _one(self) -> "ReminderIn":
        if (self.due_at is None) == (self.due_date is None):
            raise ValueError("Provide either due_at (a date-time) or due_date (a date)")
        if self.due_at is not None and self.due_at.tzinfo is None:
            raise ValueError("due_at must include a timezone offset")
        return self


def local_to_utc(d: date, t: time, tz: ZoneInfo) -> tuple[datetime, str | None]:
    """Convert a wall-clock time to UTC. DST gap -> shift forward to the first valid instant;
    DST overlap -> the earlier instant (fold=0). Returns (utc, note)."""
    naive = datetime.combine(d, t)
    aware = naive.replace(tzinfo=tz, fold=0)
    utc = aware.astimezone(UTC)
    back = utc.astimezone(tz).replace(tzinfo=None)
    if back != naive:  # nonexistent local time (spring-forward gap)
        return (aware + timedelta(hours=1)).astimezone(UTC), "Adjusted for a daylight-saving gap."
    if naive.replace(tzinfo=tz, fold=1).utcoffset() != aware.utcoffset():
        return utc, "Ambiguous local time (daylight-saving overlap); the earlier occurrence is used."
    return utc, None


def _rem_out(r: Reminder) -> dict[str, Any]:
    return {"id": str(r.id), "title": r.title, "job_id": str(r.job_id) if r.job_id else None,
            "application_id": str(r.application_id) if r.application_id else None, "due_at": r.due_at,
            "due_date": r.due_date, "timezone": r.timezone, "status": r.status, "processed_at": r.processed_at,
            "late_by_seconds": r.late_by_seconds, "created_at": r.created_at}


@router.post("/reminders", status_code=201)
def create_reminder(body: ReminderIn, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    tzname = body.timezone or actor.timezone
    try:
        tz = ZoneInfo(tzname)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise ValidationFailed("Unknown timezone", fields={"timezone": "invalid"}) from e
    if body.job_id:
        get_job(db, actor.id, body.job_id)
    if body.application_id:
        a = _get_app(db, actor.id, body.application_id)
        body.job_id = body.job_id or a.job_id
    note = None
    if body.due_date:
        due_at, note = local_to_utc(body.due_date, body.remind_time, tz)
    else:
        assert body.due_at is not None
        due_at = body.due_at.astimezone(UTC)
    r = Reminder(owner_id=actor.id, job_id=body.job_id, application_id=body.application_id, title=body.title,
                 due_at=due_at, due_date=body.due_date, timezone=tzname)
    db.add(r)
    db.commit()
    out = _rem_out(r)
    out["note"] = note
    if due_at < datetime.now(UTC):
        out["note"] = "This time is in the past; the reminder will be delivered on the next scheduler run."
    return out


@router.get("/reminders")
def list_reminders(ctx: Authed, status: Literal["scheduled", "processed", "cancelled", "all"] = "scheduled",
                   job_id: uuid.UUID | None = None, limit: int = Query(default=50, ge=1, le=200)) -> list[dict[str, Any]]:
    db, actor = ctx
    stmt = select(Reminder).where(Reminder.owner_id == actor.id)
    if status != "all":
        stmt = stmt.where(Reminder.status == status)
    if job_id:
        stmt = stmt.where(Reminder.job_id == job_id)
    order = Reminder.due_at.asc() if status == "scheduled" else Reminder.due_at.desc()
    return [_rem_out(r) for r in db.execute(stmt.order_by(order).limit(limit)).scalars()]


@router.post("/reminders/{rid}/cancel")
def cancel_reminder(rid: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    r = db.execute(select(Reminder).where(Reminder.id == rid, Reminder.owner_id == actor.id).with_for_update()
                   ).scalar_one_or_none()
    if r is None:
        raise NotFound("Reminder not found")
    if r.status == "scheduled":
        r.status = "cancelled"
        db.commit()
    return _rem_out(r)


@router.get("/reminders/{rid}/calendar.ics")
def reminder_ics(rid: uuid.UUID, ctx: Authed) -> Response:
    """A downloadable calendar file. Downloading it does not sync any calendar."""
    db, actor = ctx
    r = db.execute(select(Reminder).where(Reminder.id == rid, Reminder.owner_id == actor.id)).scalar_one_or_none()
    if r is None:
        raise NotFound("Reminder not found")

    def esc(s: str) -> str:
        return s.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    start = r.due_at.astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    body = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Elevate//Reminders//EN", "BEGIN:VEVENT",
                        f"UID:{r.id}@elevate.local", f"DTSTAMP:{stamp}", f"DTSTART:{start}",
                        f"SUMMARY:{esc(r.title)}", "END:VEVENT", "END:VCALENDAR", ""])
    return Response(body, media_type="text/calendar; charset=utf-8",
                    headers={"Content-Disposition": f'attachment; filename="reminder-{r.id}.ics"'})

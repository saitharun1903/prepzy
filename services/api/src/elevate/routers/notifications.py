import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Query
from sqlalchemy import func, select, update

from ..deps import Authed
from ..errors import NotFound
from ..models import Notification

router = APIRouter(prefix="/api/v1/notifications", tags=["notifications"])


def _out(n: Notification) -> dict[str, Any]:
    return {"id": str(n.id), "kind": n.kind, "title": n.title, "body": n.body, "link": n.link,
            "created_at": n.created_at, "read_at": n.read_at, "dismissed_at": n.dismissed_at}


@router.get("")
def list_notifications(ctx: Authed, include_dismissed: bool = False, limit: int = Query(default=50, ge=1, le=200)
                       ) -> dict[str, Any]:
    db, actor = ctx
    stmt = select(Notification).where(Notification.owner_id == actor.id)
    if not include_dismissed:
        stmt = stmt.where(Notification.dismissed_at.is_(None))
    items = [_out(n) for n in db.execute(stmt.order_by(Notification.created_at.desc()).limit(limit)).scalars()]
    unread = db.execute(select(func.count()).select_from(Notification).where(
        Notification.owner_id == actor.id, Notification.read_at.is_(None), Notification.dismissed_at.is_(None))).scalar_one()
    return {"items": items, "unread": unread}


def _get(db: Any, owner: uuid.UUID, nid: uuid.UUID) -> Notification:
    n = db.execute(select(Notification).where(Notification.id == nid, Notification.owner_id == owner)).scalar_one_or_none()
    if n is None:
        raise NotFound("Notification not found")
    return n


@router.post("/{nid}/read", status_code=204)
def mark_read(nid: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    n = _get(db, actor.id, nid)
    n.read_at = n.read_at or datetime.now(UTC)
    db.commit()


@router.post("/{nid}/dismiss", status_code=204)
def dismiss(nid: uuid.UUID, ctx: Authed) -> None:
    db, actor = ctx
    n = _get(db, actor.id, nid)
    now = datetime.now(UTC)
    n.dismissed_at, n.read_at = now, n.read_at or now
    db.commit()


@router.post("/read-all", status_code=204)
def read_all(ctx: Authed) -> None:
    db, actor = ctx
    db.execute(update(Notification).where(Notification.owner_id == actor.id, Notification.read_at.is_(None))
               .values(read_at=datetime.now(UTC)))
    db.commit()

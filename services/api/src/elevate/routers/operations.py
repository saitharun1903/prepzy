import uuid
from typing import Any

from fastapi import APIRouter, Response
from sqlalchemy import select

from ..deps import Authed
from ..models import Operation
from ..services import operations as ops

router = APIRouter(prefix="/api/v1/operations", tags=["operations"])


@router.get("")
def list_operations(ctx: Authed, active: bool = True) -> list[dict[str, Any]]:
    db, actor = ctx
    stmt = select(Operation).where(Operation.owner_id == actor.id)
    if active:
        stmt = stmt.where(Operation.state.in_(ops.ACTIVE))
    return [ops.to_public(o) for o in db.execute(stmt.order_by(Operation.created_at.desc()).limit(50)).scalars()]


@router.get("/{op_id}")
def get_operation(op_id: uuid.UUID, ctx: Authed, response: Response) -> dict[str, Any]:
    db, actor = ctx
    op = ops.get_owned(db, actor.id, op_id)
    if op.state not in ops.TERMINAL:
        response.headers["Retry-After"] = "2"
    return ops.to_public(op)


@router.post("/{op_id}/cancel")
def cancel_operation(op_id: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    """Cooperative cancellation. If inference is already running it cannot be interrupted mid-call;
    the state stays 'cancellation_requested' until the worker reaches its next checkpoint."""
    db, actor = ctx
    return ops.to_public(ops.request_cancel(db, actor.id, op_id))


@router.post("/{op_id}/retry")
def retry_operation(op_id: uuid.UUID, ctx: Authed) -> dict[str, Any]:
    db, actor = ctx
    return ops.to_public(ops.user_retry(db, actor.id, op_id))

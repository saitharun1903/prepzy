"""Durable operations backed by PostgreSQL.

State machine:
  queued -> running -> succeeded | partially_succeeded | failed | timed_out | cancelled
  queued -> cancelled                      (cancel before start)
  running -> cancellation_requested -> cancelled | succeeded (if it finished first; recorded honestly)
  running (lease expired) -> queued (retry, attempt < max) | failed
Fencing: a worker may only write results while (lease_owner, attempt) still match its claim.
"""

from __future__ import annotations

import hashlib
import json
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..errors import Conflict, Forbidden, NotFound, TooManyRequests
from ..models import Operation

AI_KINDS = {"job_analysis", "resume_suggest", "resume_tailor", "apply_kit", "interview_generate", "answer_evaluate", "job_qa", "knowledge_ingest"}
TERMINAL = {"succeeded", "partially_succeeded", "failed", "timed_out", "cancelled"}
ACTIVE = {"queued", "running", "cancellation_requested"}


def payload_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()


def create(db: Session, owner_id: uuid.UUID | None, kind: str, payload: dict[str, Any],
           idempotency_key: str | None = None) -> tuple[Operation, bool]:
    """Persist an accepted operation. Returns (op, created). Caller commits."""
    s = get_settings()
    h = payload_hash(payload)
    if idempotency_key:
        existing = db.execute(select(Operation).where(Operation.owner_id == owner_id, Operation.kind == kind,
                                                      Operation.idempotency_key == idempotency_key)).scalar_one_or_none()
        if existing:
            if existing.payload_hash != h:
                raise Conflict("This idempotency key was already used with a different request.",
                               code="idempotency_conflict")
            return existing, False
    if owner_id is not None and s.require_verified_email and kind in AI_KINDS:
        from ..models import User
        verified = db.execute(select(User.email_verified_at).where(User.id == owner_id)).scalar()
        if verified is None:
            raise Forbidden("Confirm your email address to use AI features. Check your inbox or resend the link "
                            "from Settings.", code="email_unverified")
    if owner_id is not None:
        active = db.execute(select(func.count()).select_from(Operation).where(
            Operation.owner_id == owner_id, Operation.state.in_(ACTIVE))).scalar_one()
        if active >= s.max_queued_operations_per_user:
            raise TooManyRequests("You have too many operations in progress. Wait for some to finish.",
                                  code="queue_full", extra={"retry_after": 30})
    op = Operation(owner_id=owner_id, kind=kind, payload=payload, idempotency_key=idempotency_key, payload_hash=h,
                   max_attempts=s.operation_max_attempts, stage="queued",
                   deadline_at=datetime.now(UTC) + timedelta(minutes=s.operation_deadline_minutes))
    db.add(op)
    db.flush()
    return op, True


def get_owned(db: Session, owner_id: uuid.UUID, op_id: uuid.UUID) -> Operation:
    op = db.execute(select(Operation).where(Operation.id == op_id, Operation.owner_id == owner_id)).scalar_one_or_none()
    if op is None:
        raise NotFound("Operation not found")
    return op


def request_cancel(db: Session, owner_id: uuid.UUID, op_id: uuid.UUID) -> Operation:
    op = db.execute(select(Operation).where(Operation.id == op_id, Operation.owner_id == owner_id)
                    .with_for_update()).scalar_one_or_none()
    if op is None:
        raise NotFound("Operation not found")
    if op.state in TERMINAL:
        return op
    op.cancel_requested = True
    if op.state == "queued":
        op.state, op.stage, op.finished_at = "cancelled", "cancelled", datetime.now(UTC)
    else:
        op.state = "cancellation_requested"
    db.commit()
    return op


def to_public(op: Operation) -> dict[str, Any]:
    return {
        "id": str(op.id), "kind": op.kind, "state": op.state, "stage": op.stage, "attempt": op.attempt,
        "max_attempts": op.max_attempts, "cancel_requested": op.cancel_requested, "error": op.error,
        "result": op.result, "created_at": op.created_at, "started_at": op.started_at,
        "finished_at": op.finished_at, "deadline_at": op.deadline_at,
        "terminal": op.state in TERMINAL,
    }


# ---------------------------------------------------------------- worker-side (system session)
CLAIM_SQL = text("""
with candidate as (
  select id from operations
  where (state = 'queued' and run_after <= now())
     or (state in ('running', 'cancellation_requested') and lease_expires_at < now())
  order by created_at
  for update skip locked
  limit 1
)
update operations o set
  state = case when o.cancel_requested then 'cancellation_requested' else 'running' end,
  attempt = o.attempt + 1,
  lease_owner = :worker,
  lease_expires_at = now() + make_interval(secs => :lease),
  heartbeat_at = now(),
  started_at = coalesce(o.started_at, now()),
  stage = 'starting'
from candidate where o.id = candidate.id
returning o.id
""")


def claim(db: Session, worker_id: str) -> Operation | None:
    lease = get_settings().worker_lease_seconds
    row = db.execute(CLAIM_SQL, {"worker": worker_id, "lease": lease}).first()
    db.commit()
    if not row:
        return None
    op = db.get(Operation, row[0], populate_existing=True)
    assert op is not None
    now = datetime.now(UTC)
    if op.attempt > op.max_attempts:
        finish(db, op, worker_id, op.attempt, "failed",
               error={"code": "attempts_exhausted", "message": "The operation failed after repeated attempts.",
                      "retryable": False})
        return None
    if op.deadline_at <= now:
        finish(db, op, worker_id, op.attempt, "timed_out",
               error={"code": "deadline_exceeded", "message": "The operation exceeded its deadline.", "retryable": True})
        return None
    if op.cancel_requested:
        finish(db, op, worker_id, op.attempt, "cancelled", stage="cancelled")
        return None
    return op


def _fence(op_id: uuid.UUID, worker_id: str, attempt: int) -> Any:
    return (Operation.id == op_id) & (Operation.lease_owner == worker_id) & (Operation.attempt == attempt) & \
        (Operation.state.in_(("running", "cancellation_requested")))


def heartbeat(db: Session, op_id: uuid.UUID, worker_id: str, attempt: int, stage: str | None = None) -> bool:
    """Extend lease. Returns False if this worker lost the lease (must stop and not write)."""
    vals: dict[str, Any] = {"heartbeat_at": func.now(),
                            "lease_expires_at": func.now() + timedelta(seconds=get_settings().worker_lease_seconds)}
    if stage:
        vals["stage"] = stage
    n = db.execute(update(Operation).where(_fence(op_id, worker_id, attempt)).values(**vals)).rowcount
    db.commit()
    return n == 1


def is_cancel_requested(db: Session, op_id: uuid.UUID) -> bool:
    return bool(db.execute(select(Operation.cancel_requested).where(Operation.id == op_id)).scalar())


def finish(db: Session, op: Operation, worker_id: str, attempt: int, state: str, *, result: dict[str, Any] | None = None,
           error: dict[str, Any] | None = None, stage: str | None = None, commit: bool = True) -> bool:
    """Fenced terminal write. If ``commit`` is False the caller commits (to make result rows atomic)."""
    n = db.execute(update(Operation).where(_fence(op.id, worker_id, attempt)).values(
        state=state, stage=stage or state, result=result, error=error, finished_at=func.now(),
        lease_owner=None, lease_expires_at=None)).rowcount
    if commit:
        db.commit()
    return n == 1


def retry_later(db: Session, op: Operation, worker_id: str, attempt: int, error: dict[str, Any]) -> bool:
    delay = min(120, 15 * (2 ** (attempt - 1)))  # 15 s, 30 s, ... (model restarts take ~10-30 s)
    n = db.execute(update(Operation).where(_fence(op.id, worker_id, attempt)).values(
        state="queued", stage="retry_scheduled", error=error, lease_owner=None, lease_expires_at=None,
        run_after=func.now() + timedelta(seconds=delay))).rowcount
    db.commit()
    return n == 1


def user_retry(db: Session, owner_id: uuid.UUID, op_id: uuid.UUID) -> Operation:
    op = db.execute(select(Operation).where(Operation.id == op_id, Operation.owner_id == owner_id)
                    .with_for_update()).scalar_one_or_none()
    if op is None:
        raise NotFound("Operation not found")
    if op.state not in ("failed", "timed_out"):
        raise Conflict("Only failed or timed-out operations can be retried.", code="not_retryable")
    s = get_settings()
    op.state, op.stage, op.error, op.result = "queued", "queued", None, None
    op.attempt, op.cancel_requested, op.finished_at = 0, False, None
    op.run_after = datetime.now(UTC)
    op.deadline_at = datetime.now(UTC) + timedelta(minutes=s.operation_deadline_minutes)
    db.commit()
    return op

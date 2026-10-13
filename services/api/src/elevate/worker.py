"""Durable background worker: `uv run python -m elevate.worker`.

* Claims operations atomically (SKIP LOCKED), runs them in a bounded thread pool, heartbeats the
  lease, and fences every write by (lease_owner, attempt) so a stale attempt cannot overwrite a
  newer one. No DB transaction is held open during inference.
* Runs the reminder scheduler and deletion/retention cleanup on a fixed cadence.
Safe to run more than once; safe to kill at any point (leases expire and work is re-claimed).
"""

from __future__ import annotations

import logging
import os
import signal
import socket
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy.orm import Session

from .config import get_settings
from .db import system_session, user_session
from .errors import AppError
from .logs import log, operation_id_var, setup_logging
from .models import Operation
from .services import operations as ops

logger = logging.getLogger("elevate.worker")


class LeaseLost(Exception):
    pass


class Cancelled(Exception):
    pass


@dataclass
class OpContext:
    op: Operation
    worker_id: str
    attempt: int
    _stage: str = field(default="starting")

    @property
    def owner_id(self) -> uuid.UUID | None:
        return self.op.owner_id

    @property
    def payload(self) -> dict[str, Any]:
        return self.op.payload

    def stage(self, name: str) -> None:
        """Record a real stage transition; also checks cancellation and lease ownership."""
        self._stage = name
        with system_session() as db:
            if not ops.heartbeat(db, self.op.id, self.worker_id, self.attempt, name):
                raise LeaseLost()
            if ops.is_cancel_requested(db, self.op.id):
                raise Cancelled()

    def cancelled(self) -> bool:
        with system_session() as db:
            return ops.is_cancel_requested(db, self.op.id)

    @contextmanager
    def owner_db(self) -> Iterator[Session]:
        with user_session(self.owner_id) as db:
            if self.owner_id is None:
                db.info["system"] = True
            yield db

    def commit_result(self, write: Callable[[Session], dict[str, Any]], state: str = "succeeded") -> dict[str, Any]:
        """Atomically persist result rows and the terminal state, only if we still hold the lease
        and cancellation was not requested in the meantime."""
        with self.owner_db() as db:
            if ops.is_cancel_requested(db, self.op.id):
                db.rollback()
                raise Cancelled()
            result = write(db)
            if not ops.finish(db, self.op, self.worker_id, self.attempt, state, result=result, commit=False):
                db.rollback()
                raise LeaseLost()
            db.commit()
            return result


Handler = Callable[[OpContext], None]
HANDLERS: dict[str, Handler] = {}


def handler(kind: str) -> Callable[[Handler], Handler]:
    def deco(fn: Handler) -> Handler:
        HANDLERS[kind] = fn
        return fn
    return deco


def _heartbeat_loop(ctx: OpContext, stop: threading.Event) -> None:
    interval = max(5, get_settings().worker_lease_seconds // 3)
    while not stop.wait(interval):
        try:
            with system_session() as db:
                if not ops.heartbeat(db, ctx.op.id, ctx.worker_id, ctx.attempt):
                    return
        except Exception:  # noqa: BLE001 - heartbeat failure must not kill the worker; lease expiry handles it
            logger.warning("heartbeat failed", exc_info=True)


def run_operation(op: Operation, worker_id: str) -> None:
    token = operation_id_var.set(str(op.id))
    ctx = OpContext(op, worker_id, op.attempt)
    stop = threading.Event()
    hb = threading.Thread(target=_heartbeat_loop, args=(ctx, stop), daemon=True)
    hb.start()
    started = time.monotonic()
    try:
        fn = HANDLERS.get(op.kind)
        if fn is None:
            with system_session() as db:
                ops.finish(db, op, worker_id, op.attempt, "failed",
                           error={"code": "unknown_kind", "message": "Unsupported operation.", "retryable": False})
            return
        fn(ctx)
        log(logger, logging.INFO, "operation finished", kind=op.kind, attempt=op.attempt,
            ms=int((time.monotonic() - started) * 1000))
    except Cancelled:
        with system_session() as db:
            ops.finish(db, op, worker_id, op.attempt, "cancelled", stage="cancelled")
        log(logger, logging.INFO, "operation cancelled", kind=op.kind)
    except LeaseLost:
        log(logger, logging.WARNING, "lease lost; result discarded", kind=op.kind)
    except AppError as e:
        err = {"code": e.code, "message": e.message, "retryable": e.retryable}
        with system_session() as db:
            if e.retryable and op.attempt < op.max_attempts:
                ops.retry_later(db, op, worker_id, op.attempt, err)
            else:
                ops.finish(db, op, worker_id, op.attempt, "failed", error=err)
        log(logger, logging.WARNING, "operation error", kind=op.kind, code=e.code)
    except Exception:  # noqa: BLE001 - unexpected bug: record a safe error, keep the worker alive
        logger.exception("operation crashed")
        with system_session() as db:
            err = {"code": "internal_error", "message": "An unexpected error occurred.", "retryable": True}
            if op.attempt < op.max_attempts:
                ops.retry_later(db, op, worker_id, op.attempt, err)
            else:
                ops.finish(db, op, worker_id, op.attempt, "failed", error=err)
    finally:
        stop.set()
        operation_id_var.reset(token)


def main() -> None:
    setup_logging(get_settings().log_level)
    stopping = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    serve(stopping)


def start_embedded() -> threading.Event:
    """Run the worker loop on a daemon thread inside the API process (ELEVATE_EMBEDDED_WORKER).
    Returns the event that stops it; in-flight work left behind is re-claimed after its lease expires."""
    stopping = threading.Event()
    threading.Thread(target=serve, args=(stopping,), name="elevate-worker", daemon=True).start()
    return stopping


def serve(stopping: threading.Event) -> None:
    s = get_settings()
    from . import handlers, handlers_more  # noqa: F401 - registers handlers
    from .services import scheduler

    worker_id = f"{socket.gethostname()}:{os.getpid()}:{uuid.uuid4().hex[:6]}"
    log(logger, logging.INFO, "worker started", worker=worker_id, concurrency=s.worker_concurrency,
        kinds=sorted(HANDLERS))
    pool = ThreadPoolExecutor(max_workers=s.worker_concurrency)
    inflight: set[Any] = set()
    last_sched = 0.0
    while not stopping.is_set():
        try:
            if time.monotonic() - last_sched > 30:
                scheduler.tick()
                last_sched = time.monotonic()
            inflight = {f for f in inflight if not f.done()}
            claimed = False
            if len(inflight) < s.worker_concurrency:
                with system_session() as db:
                    op = ops.claim(db, worker_id)
                if op is not None:
                    inflight.add(pool.submit(run_operation, op, worker_id))
                    claimed = True
            if not claimed:
                stopping.wait(s.worker_poll_seconds)
        except Exception:  # noqa: BLE001 - DB outage etc.: back off and keep going
            logger.exception("worker loop error; backing off")
            stopping.wait(10)
    log(logger, logging.INFO, "worker stopping; waiting for in-flight operations")
    pool.shutdown(wait=True)


if __name__ == "__main__":
    # Re-import under the canonical module name so handler registration and lookup share one registry.
    from elevate.worker import main as _main
    _main()

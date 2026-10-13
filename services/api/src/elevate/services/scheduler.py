"""Reminder scheduler + retention cleanup. Runs inside the worker every ~30s.

Reminder rule: a reminder fires once when ``due_at <= now``. After downtime (sleeping laptop),
overdue reminders are delivered on the next tick with ``late_by_seconds`` recorded and the
notification marked as late. Idempotent: notifications.reminder_id is UNIQUE and the insert uses
ON CONFLICT DO NOTHING, so retries/concurrent workers cannot duplicate delivery.
"""

from __future__ import annotations

import logging
import shutil
from datetime import UTC, datetime, timedelta
from pathlib import Path

from sqlalchemy import select, text

from ..config import get_settings
from ..db import system_session
from ..logs import log
from ..models import DeletionJob

logger = logging.getLogger("elevate.scheduler")

DUE_SQL = text("""
select id, owner_id, title, due_at, job_id, application_id from reminders
where status = 'scheduled' and due_at <= now()
order by due_at limit 100 for update skip locked
""")


def process_due_reminders() -> int:
    n = 0
    with system_session() as db:
        rows = db.execute(DUE_SQL).all()
        now = datetime.now(UTC)
        for r in rows:
            late = int((now - r.due_at).total_seconds())
            link = f"/jobs/{r.job_id}" if r.job_id else "/applications"
            body = "Reminder" if late < 300 else "Delivered late (your computer was likely offline when it was due)."
            db.execute(text("""
                insert into notifications (owner_id, reminder_id, kind, title, body, link)
                values (:o, :r, 'reminder', :t, :b, :l) on conflict (reminder_id) do nothing"""),
                       {"o": r.owner_id, "r": r.id, "t": r.title, "b": body, "l": link})
            db.execute(text("update reminders set status='processed', processed_at=now(), late_by_seconds=:late "
                            "where id=:id"), {"id": r.id, "late": max(0, late)})
            n += 1
        db.commit()
    if n:
        log(logger, logging.INFO, "reminders processed", count=n)
    return n


def process_deletion_jobs() -> None:
    with system_session() as db:
        jobs = db.execute(select(DeletionJob).where(DeletionJob.status == "pending").with_for_update(skip_locked=True)
                          .limit(10)).scalars().all()
        root = get_settings().data_dir.resolve()
        for j in jobs:
            j.attempts += 1
            try:
                if j.storage_path.startswith("owner:"):
                    # Current format: remove every stored object of that owner (local disk or S3).
                    import uuid as _uuid

                    from .storage import get_storage
                    owner = _uuid.UUID(j.storage_path.split(":", 1)[1])
                    get_storage().delete_owner(owner)
                    (get_settings().data_dir / "users" / str(owner)).exists() and shutil.rmtree(
                        get_settings().data_dir / "users" / str(owner), ignore_errors=True)
                else:  # legacy rows: an absolute local directory under the data dir
                    p = Path(j.storage_path).resolve()
                    if root not in p.parents:
                        j.status = "failed"
                        continue
                    if p.exists():
                        shutil.rmtree(p)
                j.status, j.finished_at = "done", datetime.now(UTC)
            except Exception:  # noqa: BLE001 - storage outage: retry on the next tick, give up after 5
                logger.warning("deletion job failed; will retry", exc_info=True)
                if j.attempts >= 5:
                    j.status = "failed"
        db.commit()


def cleanup_exports() -> None:
    s = get_settings()
    root = s.data_dir / "exports"
    if not root.exists():
        return
    cutoff = datetime.now(UTC) - timedelta(hours=s.export_retention_hours)
    for f in root.glob("*/*.json"):
        if datetime.fromtimestamp(f.stat().st_mtime, UTC) < cutoff:
            f.unlink(missing_ok=True)
    tmp = s.data_dir / "tmp"
    if tmp.exists():
        for f in tmp.iterdir():
            if datetime.fromtimestamp(f.stat().st_mtime, UTC) < datetime.now(UTC) - timedelta(hours=1):
                f.unlink(missing_ok=True)


def prune_security_tables() -> None:
    """Drop expired rate-limit windows and used/expired auth tokens (bounded table growth)."""
    with system_session() as db:
        db.execute(text("delete from rate_limit_buckets where window_start < now() - interval '2 days'"))
        db.execute(text("delete from auth_tokens where expires_at < now() - interval '7 days'"))
        db.commit()


def tick() -> None:
    process_due_reminders()
    process_deletion_jobs()
    cleanup_exports()
    prune_security_tables()

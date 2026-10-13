"""Operator commands (local profile). Run: `uv run python -m elevate.cli <command>`.

  reset-password <email>         Account recovery without email: sets a new random password and prints it
                                 ONCE to the operator console; revokes all sessions. (No email is sent.)
  ingest <file> --title T --license L [--domain D] [--skills a,b] [--url U]
                                 Queue a SHARED knowledge source (admin path) from a local UTF-8 text/markdown file.
  ops [--failed]                 List recent operations (no payload contents) for troubleshooting.
  retry <operation_id>           Re-queue a failed/timed-out operation.
  status                         Capability + queue status.
"""

from __future__ import annotations

import argparse
import hashlib
import secrets
import sys
import uuid
from pathlib import Path

from sqlalchemy import func, select, text, update

from .db import system_session
from .models import KnowledgeSource, KnowledgeVersion, Operation, RefreshToken, User
from .security import hash_password
from .services import operations as ops
from .services import rag
from .services.llm import get_provider
from .services.taxonomy import load_taxonomy


def reset_password(email: str) -> int:
    with system_session() as db:
        u = db.execute(select(User).where(func.lower(User.email) == email.lower())).scalar_one_or_none()
        if u is None or u.deleted_at:
            print("No active account with that email.", file=sys.stderr)
            return 1
        pw = secrets.token_urlsafe(12)
        u.password_hash, u.token_version = hash_password(pw), u.token_version + 1
        db.execute(update(RefreshToken).where(RefreshToken.user_id == u.id).values(revoked_at=func.now()))
        db.commit()
    print(f"Temporary password (shown once; ask the user to change it in Settings): {pw}")
    return 0


def ingest(path: str, title: str, license_basis: str, domain: str | None, skills: str, url: str | None) -> int:
    body = Path(path).read_text(encoding="utf-8")
    tax = load_taxonomy()
    sk = [s for s in skills.split(",") if s]
    if domain and domain not in tax.domains or any(s not in tax.skills for s in sk):
        print("Unknown domain or skill id.", file=sys.stderr)
        return 2
    with system_session() as db:
        src = db.execute(select(KnowledgeSource).where(KnowledgeSource.visibility == "shared",
                                                       KnowledgeSource.title == title,
                                                       KnowledgeSource.deleted_at.is_(None))).scalar_one_or_none()
        if src is None:
            src = KnowledgeSource(owner_id=None, visibility="shared", title=title, source_type="upload", source_url=url,
                                  domain=domain, skills=sk, license_basis=license_basis)
            db.add(src)
            db.flush()
        checksum = hashlib.sha256(body.encode()).hexdigest()
        if db.execute(select(KnowledgeVersion).where(KnowledgeVersion.source_id == src.id,
                                                     KnowledgeVersion.checksum == checksum)).first():
            print("Identical text already ingested for this source; nothing to do.")
            return 0
        last = db.execute(select(func.max(KnowledgeVersion.version)).where(KnowledgeVersion.source_id == src.id)).scalar()
        from .config import get_settings
        s = get_settings()
        v = KnowledgeVersion(source_id=src.id, version=(last or 0) + 1, checksum=checksum, status="pending",
                             embed_model=s.embed_model, embed_dim=s.embed_dim, ingestion_version=rag.INGESTION_VERSION,
                             text=body)
        db.add(v)
        db.flush()
        op, _ = ops.create(db, None, "knowledge_ingest", {"source_id": str(src.id), "version_id": str(v.id)})
        db.commit()
    print(f"Queued ingestion operation {op.id} (the worker must be running).")
    return 0


def list_ops(failed: bool) -> int:
    with system_session() as db:
        stmt = select(Operation).order_by(Operation.created_at.desc()).limit(30)
        if failed:
            stmt = stmt.where(Operation.state.in_(("failed", "timed_out")))
        for o in db.execute(stmt).scalars():
            err = (o.error or {}).get("code", "")
            print(f"{o.id}  {o.kind:18} {o.state:22} {o.stage or '':20} attempt={o.attempt}/{o.max_attempts} {err}")
    return 0


def retry(op_id: str) -> int:
    with system_session() as db:
        o = db.get(Operation, uuid.UUID(op_id))
        if o is None or o.state not in ("failed", "timed_out"):
            print("Operation not found or not retryable.", file=sys.stderr)
            return 1
        ops.user_retry(db, o.owner_id, o.id) if o.owner_id else None
        if o.owner_id is None:
            o.state, o.attempt, o.error = "queued", 0, None
            db.commit()
    print("Re-queued.")
    return 0


def status() -> int:
    print("AI:", get_provider().health())
    with system_session() as db:
        for row in db.execute(text("select state, count(*) from operations group by state order by 1")):
            print(f"operations {row[0]:24} {row[1]}")
        print("overdue reminders:", db.execute(text(
            "select count(*) from reminders where status='scheduled' and due_at < now() - interval '5 minutes'")).scalar())
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="elevate.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("reset-password")
    a.add_argument("email")
    b = sub.add_parser("ingest")
    b.add_argument("file")
    b.add_argument("--title", required=True)
    b.add_argument("--license", required=True, dest="license_basis")
    b.add_argument("--domain")
    b.add_argument("--skills", default="")
    b.add_argument("--url")
    c = sub.add_parser("ops")
    c.add_argument("--failed", action="store_true")
    d = sub.add_parser("retry")
    d.add_argument("operation_id")
    sub.add_parser("status")
    ns = p.parse_args(argv)
    if ns.cmd == "reset-password":
        return reset_password(ns.email)
    if ns.cmd == "ingest":
        return ingest(ns.file, ns.title, ns.license_basis, ns.domain, ns.skills, ns.url)
    if ns.cmd == "ops":
        return list_ops(ns.failed)
    if ns.cmd == "retry":
        return retry(ns.operation_id)
    return status()


if __name__ == "__main__":
    sys.exit(main())

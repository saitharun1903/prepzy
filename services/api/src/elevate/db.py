"""Engine/session management.

Row-level security: every user-owned table has a policy keyed on the transaction-local
setting ``app.user_id``. ``Session.info["user_id"]`` is applied at the start of *every*
transaction (``after_begin``) so a commit mid-request cannot drop the context. System work
(worker claiming, scheduler) uses ``Session.info["system"] = True`` which sets
``app.system = 'on'``. RLS is defence in depth; routes still filter by owner explicitly.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from uuid import UUID

from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from .config import get_settings

_engine: Engine | None = None
_factory: sessionmaker[Session] | None = None


def engine() -> Engine:
    global _engine, _factory
    if _engine is None:
        s = get_settings()
        _engine = create_engine(s.database_url, pool_size=s.db_pool_size, max_overflow=2,
                                pool_pre_ping=True, pool_recycle=1800)
        _factory = sessionmaker(bind=_engine, expire_on_commit=False)
    return _engine


def session_factory() -> sessionmaker[Session]:
    engine()
    assert _factory is not None
    return _factory


@event.listens_for(Session, "after_begin")
def _apply_rls_context(session: Session, transaction, connection) -> None:  # noqa: ANN001
    uid = session.info.get("user_id")
    system = session.info.get("system", False)
    connection.execute(
        text("select set_config('app.user_id', :uid, true), set_config('app.system', :sys, true)"),
        {"uid": str(uid) if uid else "", "sys": "on" if system else "off"},
    )


@contextmanager
def user_session(user_id: UUID | None) -> Iterator[Session]:
    s = session_factory()()
    s.info["user_id"] = user_id
    try:
        yield s
    finally:
        s.close()


@contextmanager
def system_session() -> Iterator[Session]:
    s = session_factory()()
    s.info["system"] = True
    try:
        yield s
    finally:
        s.close()

"""FastAPI dependencies: per-request DB session bound to the authenticated user (RLS), auth, rate limits."""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Request
from sqlalchemy.orm import Session

from .config import get_settings
from .db import session_factory
from .errors import Forbidden, TooManyRequests, Unauthorized
from .models import User
from .security import decode_access_token


@dataclass(frozen=True)
class Actor:
    id: UUID
    email: str
    is_admin: bool
    timezone: str
    client: str


def _bearer(authorization: str | None) -> str:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise Unauthorized("Sign in required", code="unauthenticated")
    return authorization[7:].strip()


def get_db_and_actor(authorization: Annotated[str | None, Header()] = None) -> Iterator[tuple[Session, Actor]]:
    claims = decode_access_token(_bearer(authorization))
    db = session_factory()()
    try:
        db.info["user_id"] = claims.user_id
        user = db.get(User, claims.user_id)
        if user is None or user.deleted_at is not None or user.token_version != claims.token_version:
            raise Unauthorized("Session is no longer valid", code="session_revoked")
        yield db, Actor(user.id, user.email, user.is_admin, user.timezone, claims.client)
    finally:
        db.close()


def get_public_db() -> Iterator[Session]:
    """Unauthenticated routes (register/login/refresh) operate in system context on identity tables only."""
    db = session_factory()()
    db.info["system"] = True
    try:
        yield db
    finally:
        db.close()


Authed = Annotated[tuple[Session, Actor], Depends(get_db_and_actor)]
PublicDb = Annotated[Session, Depends(get_public_db)]


def require_admin(ctx: Authed) -> tuple[Session, Actor]:
    if not ctx[1].is_admin:
        raise Forbidden("Administrator access required")
    return ctx


AdminCtx = Annotated[tuple[Session, Actor], Depends(require_admin)]


class SlidingWindowLimiter:
    """In-process limiter. Single-instance only (documented in docs/SECURITY.md)."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def check(self, key: str, limit: int, window: float = 60.0) -> None:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and q[0] <= now - window:
                q.popleft()
            if len(q) >= limit:
                raise TooManyRequests("Too many attempts. Try again in a minute.", extra={"retry_after": int(window)})
            q.append(now)


limiter = SlidingWindowLimiter()


def auth_rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    limiter.check(f"auth:{ip}", get_settings().auth_rate_per_minute)

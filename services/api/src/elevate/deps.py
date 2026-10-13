"""FastAPI dependencies: per-request DB session bound to the authenticated user (RLS), auth, rate limits."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Request
from sqlalchemy.orm import Session

from .config import get_settings
from .db import session_factory
from .errors import Forbidden, Unauthorized
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
        from .services.account_security import rate_limit
        rate_limit(db, f"api-user:{user.id}", get_settings().api_rate_per_minute)
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


def client_ip(request: Request) -> str:
    """Client address. Behind a platform proxy, uvicorn runs with --proxy-headers so this is the
    real client from X-Forwarded-For (only trusted from the configured proxy)."""
    return request.client.host if request.client else "unknown"


def auth_rate_limit(request: Request) -> None:
    """Per-IP limit on sign-in endpoints, shared by every API instance (PostgreSQL)."""
    from .db import system_session
    from .services.account_security import rate_limit
    with system_session() as db:
        rate_limit(db, f"auth-ip:{client_ip(request)}", get_settings().auth_rate_per_minute)


def require_verified_email(ctx: Authed) -> tuple[Session, Actor]:
    """Gate expensive AI operations behind a verified email when the deployment requires it."""
    db, actor = ctx
    if get_settings().require_verified_email:
        u = db.get(User, actor.id)
        if u is None or u.email_verified_at is None:
            raise Forbidden("Confirm your email address to use AI analysis. Check your inbox or resend the link "
                            "from Settings.", code="email_unverified")
    return ctx

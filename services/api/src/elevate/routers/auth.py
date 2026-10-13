import re
from datetime import UTC, datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, update

from ..config import get_settings
from ..deps import Authed, PublicDb, auth_rate_limit
from ..errors import Conflict, Unauthorized, ValidationFailed
from ..models import AuditEvent, Profile, RefreshToken, User
from ..security import (
    hash_password,
    issue_access_token,
    issue_refresh_token,
    revoke_refresh_token,
    rotate_refresh_token,
    verify_password,
)

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
_EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]+\.[^@\s]{2,}$")


def _valid_tz(v: str) -> str:
    try:
        ZoneInfo(v)
    except (ZoneInfoNotFoundError, ValueError) as e:
        raise ValueError("Unknown IANA timezone") from e
    return v


class Credentials(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(min_length=1, max_length=128)
    client: Literal["web", "extension"] = "web"

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL.match(v):
            raise ValueError("Enter a valid email address")
        return v


class Registration(Credentials):
    password: str = Field(min_length=10, max_length=128)
    display_name: str | None = Field(default=None, max_length=120)
    timezone: str = Field(default="UTC", max_length=64)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        return _valid_tz(v)


class UserOut(BaseModel):
    id: str
    email: str
    display_name: str | None
    is_admin: bool
    timezone: str


class TokenOut(BaseModel):
    access_token: str
    expires_in: int
    refresh_token: str
    user: UserOut


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=200)


def user_out(u: User) -> UserOut:
    return UserOut(id=str(u.id), email=u.email, display_name=u.display_name, is_admin=u.is_admin, timezone=u.timezone)


def _tokens(db: PublicDb, user: User, client: str) -> TokenOut:
    refresh = issue_refresh_token(db, user.id, client)
    db.commit()
    access, exp = issue_access_token(user, client)
    return TokenOut(access_token=access, expires_in=exp, refresh_token=refresh, user=user_out(user))


@router.post("/register", response_model=TokenOut, status_code=201, dependencies=[Depends(auth_rate_limit)])
def register(body: Registration, db: PublicDb) -> TokenOut:
    if db.execute(select(User.id).where(func.lower(User.email) == body.email)).first():
        # Registration necessarily reveals existence; the message stays generic and rate-limited.
        raise Conflict("An account with this email may already exist. Try signing in.", code="email_unavailable")
    user = User(email=body.email, password_hash=hash_password(body.password), display_name=body.display_name,
                timezone=body.timezone, is_admin=body.email in get_settings().admin_email_set)
    db.add(user)
    db.flush()
    db.add(Profile(user_id=user.id))
    db.add(AuditEvent(user_id=user.id, action="account.registered"))
    return _tokens(db, user, body.client)


@router.post("/login", response_model=TokenOut, dependencies=[Depends(auth_rate_limit)])
def login(body: Credentials, db: PublicDb) -> TokenOut:
    user = db.execute(select(User).where(func.lower(User.email) == body.email)).scalar_one_or_none()
    ok = verify_password(user.password_hash if user else None, body.password)
    if not user or not ok or user.deleted_at is not None:
        raise Unauthorized("Email or password is incorrect.", code="invalid_credentials")
    admin = body.email in get_settings().admin_email_set
    if user.is_admin != admin:
        user.is_admin = admin
    db.add(AuditEvent(user_id=user.id, action="auth.login", meta={"client": body.client}))
    return _tokens(db, user, body.client)


@router.post("/refresh", response_model=TokenOut, dependencies=[Depends(auth_rate_limit)])
def refresh(body: RefreshIn, db: PublicDb) -> TokenOut:
    user, new_refresh, client = rotate_refresh_token(db, body.refresh_token)
    db.commit()
    access, exp = issue_access_token(user, client)
    return TokenOut(access_token=access, expires_in=exp, refresh_token=new_refresh, user=user_out(user))


@router.post("/logout", status_code=204)
def logout(body: RefreshIn, db: PublicDb) -> None:
    revoke_refresh_token(db, body.refresh_token)
    db.commit()


@router.post("/logout-all", status_code=204)
def logout_all(ctx: Authed) -> None:
    db, actor = ctx
    u = db.get(User, actor.id)
    assert u is not None
    u.token_version += 1
    db.execute(update(RefreshToken).where(RefreshToken.user_id == actor.id, RefreshToken.revoked_at.is_(None))
               .values(revoked_at=datetime.now(UTC)))
    db.commit()


class ExtensionGrant(BaseModel):
    refresh_token: str
    user: UserOut


@router.post("/extension-grant", response_model=ExtensionGrant)
def extension_grant(ctx: Authed) -> ExtensionGrant:
    """Issued to a signed-in web session that the user explicitly chose to connect to the extension.
    The web page hands it to the extension via chrome.runtime.sendMessage (externally_connectable)."""
    db, actor = ctx
    if actor.client != "web":
        raise Unauthorized("Only a web session can connect the extension.", code="wrong_client")
    refresh = issue_refresh_token(db, actor.id, "extension")
    db.add(AuditEvent(user_id=actor.id, action="auth.extension_connected"))
    db.commit()
    u = db.get(User, actor.id)
    assert u is not None
    return ExtensionGrant(refresh_token=refresh, user=user_out(u))


class PasswordChange(BaseModel):
    current_password: str = Field(max_length=128)
    new_password: str = Field(min_length=10, max_length=128)


@router.post("/change-password", status_code=204)
def change_password(body: PasswordChange, ctx: Authed) -> None:
    db, actor = ctx
    u = db.get(User, actor.id)
    assert u is not None
    if not verify_password(u.password_hash, body.current_password):
        raise ValidationFailed("Current password is incorrect.", fields={"current_password": "Incorrect password"})
    u.password_hash = hash_password(body.new_password)
    u.token_version += 1  # revoke other sessions' access tokens
    db.add(AuditEvent(user_id=u.id, action="auth.password_changed"))
    db.commit()

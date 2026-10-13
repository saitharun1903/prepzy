"""Authentication primitives built only from maintained libraries (argon2-cffi, PyJWT).

* Passwords: Argon2id (library defaults).
* Access tokens: HS256 JWT, 15 min, validated for signature, issuer, audience, expiry, algorithm,
  and the user's ``token_version`` (bumped on logout-all / deletion => immediate revocation).
* Refresh tokens: 256-bit random opaque strings, stored only as SHA-256 hashes, single-use with
  rotation. Reuse of a consumed token revokes the whole family (theft detection, RFC 9700 4.14).
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from .config import get_settings
from .errors import Unauthorized
from .models import RefreshToken, User

_hasher = PasswordHasher()
_DUMMY_HASH = _hasher.hash("timing-equaliser-not-a-password")


def hash_password(pw: str) -> str:
    return _hasher.hash(pw)


def verify_password(stored: str | None, pw: str) -> bool:
    try:
        return _hasher.verify(stored or _DUMMY_HASH, pw) and stored is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def _sha(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


@dataclass(frozen=True)
class AccessClaims:
    user_id: uuid.UUID
    token_version: int
    client: str


def issue_access_token(user: User, client: str) -> tuple[str, int]:
    s = get_settings()
    now = datetime.now(UTC)
    exp = now + timedelta(minutes=s.access_token_minutes)
    token = jwt.encode(
        {"sub": str(user.id), "iss": s.jwt_issuer, "aud": s.jwt_audience, "iat": now, "nbf": now, "exp": exp,
         "tv": user.token_version, "cl": client, "jti": secrets.token_hex(8)},
        s.jwt_secret, algorithm="HS256")
    return token, s.access_token_minutes * 60


def decode_access_token(token: str) -> AccessClaims:
    s = get_settings()
    try:
        data = jwt.decode(token, s.jwt_secret, algorithms=["HS256"], audience=s.jwt_audience, issuer=s.jwt_issuer,
                          options={"require": ["exp", "iat", "sub", "iss", "aud"]})
        return AccessClaims(uuid.UUID(data["sub"]), int(data.get("tv", 0)), str(data.get("cl", "web")))
    except jwt.ExpiredSignatureError as e:
        raise Unauthorized("Session expired", code="token_expired") from e
    except (jwt.InvalidTokenError, ValueError, KeyError) as e:
        raise Unauthorized("Invalid credentials", code="invalid_token") from e


MFA_TOKEN_SECONDS = 300


def issue_mfa_token(user: User, client: str) -> tuple[str, int]:
    """Short-lived proof that the password step passed; only accepted by /auth/login/mfa
    (distinct audience, so it can never be used as an access token)."""
    s = get_settings()
    now = datetime.now(UTC)
    token = jwt.encode({"sub": str(user.id), "iss": s.jwt_issuer, "aud": f"{s.jwt_audience}:mfa", "iat": now,
                        "exp": now + timedelta(seconds=MFA_TOKEN_SECONDS), "cl": client, "tv": user.token_version},
                       s.jwt_secret, algorithm="HS256")
    return token, MFA_TOKEN_SECONDS


def decode_mfa_token(token: str) -> tuple[uuid.UUID, str]:
    s = get_settings()
    try:
        data = jwt.decode(token, s.jwt_secret, algorithms=["HS256"], audience=f"{s.jwt_audience}:mfa", issuer=s.jwt_issuer,
                          options={"require": ["exp", "sub", "aud"]})
        client = str(data.get("cl", "web"))
        return uuid.UUID(data["sub"]), client if client in ("web", "extension") else "web"
    except (jwt.InvalidTokenError, ValueError, KeyError) as e:
        raise Unauthorized("Sign-in expired. Start again.", code="mfa_expired") from e


def issue_refresh_token(db: Session, user_id: uuid.UUID, client: str, family_id: uuid.UUID | None = None) -> str:
    raw = secrets.token_urlsafe(32)
    db.add(RefreshToken(user_id=user_id, family_id=family_id or uuid.uuid4(), token_hash=_sha(raw), client=client,
                        expires_at=datetime.now(UTC) + timedelta(days=get_settings().refresh_token_days)))
    return raw


def rotate_refresh_token(db: Session, raw: str) -> tuple[User, str, str]:
    """Consume ``raw`` and return (user, new_refresh, client). Must run in a system session."""
    now = datetime.now(UTC)
    row = db.execute(select(RefreshToken).where(RefreshToken.token_hash == _sha(raw)).with_for_update()).scalar_one_or_none()
    if row is None:
        raise Unauthorized("Invalid session", code="invalid_refresh")
    if row.used_at is not None or row.revoked_at is not None:
        # Reuse of a rotated token: revoke the family.
        db.execute(update(RefreshToken).where(RefreshToken.family_id == row.family_id, RefreshToken.revoked_at.is_(None))
                   .values(revoked_at=now))
        db.commit()
        raise Unauthorized("Session revoked", code="refresh_reused")
    if row.expires_at <= now:
        raise Unauthorized("Session expired", code="refresh_expired")
    user = db.get(User, row.user_id)
    if user is None or user.deleted_at is not None:
        raise Unauthorized("Invalid session", code="invalid_refresh")
    row.used_at = now
    new_raw = issue_refresh_token(db, user.id, row.client, row.family_id)
    return user, new_raw, row.client


def revoke_refresh_token(db: Session, raw: str) -> None:
    row = db.execute(select(RefreshToken).where(RefreshToken.token_hash == _sha(raw))).scalar_one_or_none()
    if row is not None:
        db.execute(update(RefreshToken).where(RefreshToken.family_id == row.family_id, RefreshToken.revoked_at.is_(None))
                   .values(revoked_at=datetime.now(UTC)))

"""Account security: single-use email tokens, lockout, TOTP 2-step verification, recovery codes,
and a PostgreSQL-backed rate limiter shared by every API instance.

Primitives come from maintained libraries only: pyotp (RFC 6238 TOTP), cryptography (Fernet,
AES-128-CBC + HMAC-SHA256) for secrets at rest, secrets/hashlib for tokens.
"""

from __future__ import annotations

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from functools import lru_cache

import pyotp
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select, text, update
from sqlalchemy.orm import Session

from ..config import get_settings
from ..errors import AppError, TooManyRequests, ValidationFailed
from ..models import AuthToken, MfaRecoveryCode, User

TOKEN_TTL = {"verify_email": timedelta(hours=48), "reset_password": timedelta(minutes=30)}
ISSUER = "Prepzy"


def _sha(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


# ------------------------------------------------------------------ single-use email tokens
def issue_token(db: Session, user_id: uuid.UUID, kind: str) -> str:
    """Create a token; earlier unused tokens of the same kind are invalidated. Caller commits."""
    now = datetime.now(UTC)
    db.execute(update(AuthToken).where(AuthToken.user_id == user_id, AuthToken.kind == kind, AuthToken.used_at.is_(None))
               .values(used_at=now))
    raw = secrets.token_urlsafe(32)
    db.add(AuthToken(user_id=user_id, kind=kind, token_hash=_sha(raw), expires_at=now + TOKEN_TTL[kind]))
    return raw


def consume_token(db: Session, raw: str, kind: str) -> User:
    now = datetime.now(UTC)
    row = db.execute(select(AuthToken).where(AuthToken.token_hash == _sha(raw), AuthToken.kind == kind)
                     .with_for_update()).scalar_one_or_none()
    if row is None or row.used_at is not None or row.expires_at <= now:
        raise ValidationFailed("This link is invalid or has expired. Request a new one.", code="invalid_link")
    user = db.get(User, row.user_id)
    if user is None or user.deleted_at is not None:
        raise ValidationFailed("This link is invalid or has expired. Request a new one.", code="invalid_link")
    row.used_at = now
    return user


# ------------------------------------------------------------------ lockout
def check_not_locked(user: User | None) -> None:
    if user and user.locked_until and user.locked_until > datetime.now(UTC):
        # Same wording as a wrong password would reveal more; this is shown only after many failures.
        raise TooManyRequests("Too many failed sign-in attempts. Try again later or reset your password.",
                              code="account_locked", extra={"retry_after": 60})


def record_failure(user: User) -> None:
    s = get_settings()
    user.failed_logins += 1
    if user.failed_logins >= s.lockout_threshold:
        user.locked_until = datetime.now(UTC) + timedelta(minutes=s.lockout_minutes)
        user.failed_logins = 0


def record_success(user: User) -> None:
    user.failed_logins = 0
    user.locked_until = None


def _unknown_key(email: str) -> str:
    return f"lock-unknown:{_sha(email.strip().lower())}"


def record_unknown_failure(db: Session, email: str) -> None:
    """Failed logins for addresses without an account are counted the same way, so the lockout
    response cannot be used to discover which emails are registered."""
    window = get_settings().lockout_minutes * 60
    now = datetime.now(UTC)
    w = datetime.fromtimestamp(int(now.timestamp()) // window * window, UTC)
    db.execute(RATE_SQL, {"k": _unknown_key(email), "w": w})
    db.commit()


def check_unknown_not_locked(db: Session, email: str) -> None:
    s = get_settings()
    window = s.lockout_minutes * 60
    now = datetime.now(UTC)
    w = datetime.fromtimestamp(int(now.timestamp()) // window * window, UTC)
    n = db.execute(text("select count from rate_limit_buckets where key = :k and window_start = :w"),
                   {"k": _unknown_key(email), "w": w}).scalar() or 0
    if n >= s.lockout_threshold:
        raise TooManyRequests("Too many failed sign-in attempts. Try again later or reset your password.",
                              code="account_locked", extra={"retry_after": 60})


# ------------------------------------------------------------------ TOTP
@lru_cache
def _fernet() -> Fernet:
    key = get_settings().data_key
    if not key:
        raise AppError("Two-step verification is not configured on this server.", code="mfa_unavailable",
                       status_code=503)
    return Fernet(key.encode())


def encrypt(secret: str) -> str:
    return _fernet().encrypt(secret.encode()).decode()


def decrypt(blob: str) -> str:
    try:
        return _fernet().decrypt(blob.encode()).decode()
    except InvalidToken as e:
        raise AppError("Two-step verification data could not be read.", code="mfa_corrupt", status_code=500) from e


def new_totp_secret() -> str:
    return pyotp.random_base32()


def provisioning_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name=ISSUER)


def qr_svg(uri: str) -> str:
    import io

    import segno
    buf = io.BytesIO()
    segno.make(uri, error="m").save(buf, kind="svg", scale=5, border=2, xmldecl=False, svgns=True, dark="#0d1117",
                                    light="#ffffff")
    return buf.getvalue().decode("utf-8")


def verify_totp(user: User, code: str, secret: str | None = None) -> bool:
    """Accept the current code (±1 step for clock drift). A step is accepted once (replay-safe)."""
    code = code.replace(" ", "")
    if not (code.isdigit() and len(code) == 6):
        return False
    sec = secret or (decrypt(user.totp_secret_enc) if user.totp_secret_enc else None)
    if not sec:
        return False
    totp = pyotp.TOTP(sec)
    now_step = int(datetime.now(UTC).timestamp()) // totp.interval
    for step in (now_step - 1, now_step, now_step + 1):
        if secrets.compare_digest(totp.generate_otp(step), code):
            if user.totp_last_step is not None and step <= user.totp_last_step:
                return False
            user.totp_last_step = step
            return True
    return False


def new_recovery_codes(db: Session, user_id: uuid.UUID) -> list[str]:
    db.execute(text("delete from mfa_recovery_codes where user_id = :u"), {"u": user_id})
    codes = [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(10)]
    for c in codes:
        db.add(MfaRecoveryCode(user_id=user_id, code_hash=_sha(c)))
    return codes


def use_recovery_code(db: Session, user_id: uuid.UUID, code: str) -> bool:
    row = db.execute(select(MfaRecoveryCode).where(MfaRecoveryCode.user_id == user_id,
                                                   MfaRecoveryCode.code_hash == _sha(code.strip().lower()),
                                                   MfaRecoveryCode.used_at.is_(None)).with_for_update()).scalar_one_or_none()
    if row is None:
        return False
    row.used_at = datetime.now(UTC)
    return True


# ------------------------------------------------------------------ shared rate limiting
RATE_SQL = text("""
insert into rate_limit_buckets (key, window_start, count) values (:k, :w, 1)
on conflict (key, window_start) do update set count = rate_limit_buckets.count + 1
returning count
""")


def rate_limit(db: Session, key: str, limit: int, window_seconds: int = 60) -> None:
    """Fixed-window limiter in PostgreSQL: correct across any number of API instances.
    Runs in its own short transaction so a later rollback cannot undo the count."""
    now = datetime.now(UTC)
    w = datetime.fromtimestamp(int(now.timestamp()) // window_seconds * window_seconds, UTC)
    n = db.execute(RATE_SQL, {"k": key[:200], "w": w}).scalar_one()
    db.commit()
    if n > limit:
        retry = window_seconds - int(now.timestamp()) % window_seconds
        raise TooManyRequests("Too many requests. Please wait a moment and try again.", extra={"retry_after": retry})


def prune_rate_limits(db: Session) -> None:
    db.execute(text("delete from rate_limit_buckets where window_start < now() - interval '1 hour'"))
    db.commit()

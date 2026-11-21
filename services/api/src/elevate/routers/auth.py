import re
from datetime import UTC, datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, text, update

from ..config import get_settings
from ..deps import Authed, PublicDb, auth_rate_limit
from ..errors import Conflict, Unauthorized, ValidationFailed
from ..models import AuditEvent, MfaRecoveryCode, Profile, RefreshToken, User
from ..security import (
    decode_mfa_token,
    hash_password,
    issue_access_token,
    issue_mfa_token,
    issue_refresh_token,
    revoke_refresh_token,
    rotate_refresh_token,
    verify_password,
)
from ..services import account_security as sec
from ..services import email

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
    token = sec.issue_token(db, user.id, "verify_email")
    out = _tokens(db, user, body.client)
    email.send_verification(user.email, token)
    return out


class MfaChallengeOut(BaseModel):
    mfa_required: bool = True
    mfa_token: str
    expires_in: int


@router.post("/login", response_model=TokenOut | MfaChallengeOut, dependencies=[Depends(auth_rate_limit)])
def login(body: Credentials, db: PublicDb) -> TokenOut | MfaChallengeOut:
    sec.rate_limit(db, f"login-email:{body.email}", 20, 3600)  # per-account brute-force ceiling
    user = db.execute(select(User).where(func.lower(User.email) == body.email).with_for_update()).scalar_one_or_none()
    sec.check_not_locked(user)
    if user is None or user.deleted_at is not None:
        sec.check_unknown_not_locked(db, body.email)
    ok = verify_password(user.password_hash if user else None, body.password)
    if not user or not ok or user.deleted_at is not None:
        if user and user.deleted_at is None:
            sec.record_failure(user)
            db.commit()
        else:
            sec.record_unknown_failure(db, body.email)
        raise Unauthorized("Email or password is incorrect.", code="invalid_credentials")
    sec.record_success(user)
    admin = body.email in get_settings().admin_email_set
    if user.is_admin != admin:
        user.is_admin = admin
    if user.totp_enabled_at:
        db.commit()
        token, exp = issue_mfa_token(user, body.client)
        return MfaChallengeOut(mfa_token=token, expires_in=exp)
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


class MfaLoginIn(BaseModel):
    mfa_token: str = Field(min_length=20, max_length=2000)
    code: str = Field(min_length=6, max_length=20)


@router.post("/login/mfa", response_model=TokenOut, dependencies=[Depends(auth_rate_limit)])
def login_mfa(body: MfaLoginIn, db: PublicDb) -> TokenOut:
    """Second step: a 6-digit authenticator code or a one-time recovery code."""
    user_id, client = decode_mfa_token(body.mfa_token)
    sec.rate_limit(db, f"mfa:{user_id}", 10, 300)
    user = db.execute(select(User).where(User.id == user_id).with_for_update()).scalar_one_or_none()
    if user is None or user.deleted_at is not None or not user.totp_enabled_at:
        raise Unauthorized("Sign-in expired. Start again.", code="mfa_expired")
    sec.check_not_locked(user)
    code = body.code.strip()
    ok = sec.verify_totp(user, code) if code.replace(" ", "").isdigit() else sec.use_recovery_code(db, user.id, code)
    if not ok:
        sec.record_failure(user)
        db.commit()
        raise Unauthorized("That code didn't work. Check your authenticator app and try again.", code="invalid_mfa_code")
    sec.record_success(user)
    db.add(AuditEvent(user_id=user.id, action="auth.login", meta={"client": client, "mfa": True}))
    return _tokens(db, user, client)


class TokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)


@router.post("/verify-email", status_code=204, dependencies=[Depends(auth_rate_limit)])
def verify_email(body: TokenIn, db: PublicDb) -> None:
    user = sec.consume_token(db, body.token, "verify_email")
    if not user.email_verified_at:
        user.email_verified_at = datetime.now(UTC)
        db.add(AuditEvent(user_id=user.id, action="auth.email_verified"))
    db.commit()


@router.post("/resend-verification", status_code=202)
def resend_verification(ctx: Authed) -> dict[str, bool]:
    db, actor = ctx
    sec.rate_limit(db, f"resend-verify:{actor.id}", 3, 3600)
    u = db.get(User, actor.id)
    assert u is not None
    if u.email_verified_at:
        return {"sent": False}
    token = sec.issue_token(db, u.id, "verify_email")
    db.commit()
    return {"sent": email.send_verification(u.email, token)}


class ForgotIn(BaseModel):
    email: str = Field(max_length=320)


@router.post("/forgot-password", status_code=202, dependencies=[Depends(auth_rate_limit)])
def forgot_password(body: ForgotIn, db: PublicDb) -> dict[str, str]:
    """Always the same response, whether or not the address has an account (no enumeration)."""
    addr = body.email.strip().lower()
    sec.rate_limit(db, f"forgot:{addr}", 3, 3600)
    user = db.execute(select(User).where(func.lower(User.email) == addr)).scalar_one_or_none()
    if user and user.deleted_at is None:
        token = sec.issue_token(db, user.id, "reset_password")
        db.add(AuditEvent(user_id=user.id, action="auth.reset_requested"))
        db.commit()
        email.send_password_reset(user.email, token)
    return {"message": "If an account exists for that email, we've sent a link to reset the password."}


class ResetIn(BaseModel):
    token: str = Field(min_length=20, max_length=200)
    new_password: str = Field(min_length=10, max_length=128)


@router.post("/reset-password", status_code=204, dependencies=[Depends(auth_rate_limit)])
def reset_password(body: ResetIn, db: PublicDb) -> None:
    user = sec.consume_token(db, body.token, "reset_password")
    user.password_hash = hash_password(body.new_password)
    user.token_version += 1  # sign out everywhere
    user.email_verified_at = user.email_verified_at or datetime.now(UTC)  # they proved inbox access
    sec.record_success(user)
    db.execute(update(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
               .values(revoked_at=datetime.now(UTC)))
    db.add(AuditEvent(user_id=user.id, action="auth.password_reset"))
    db.commit()


# ------------------------------------------------------------------ two-step verification (TOTP)
class MfaStatus(BaseModel):
    enabled: bool
    recovery_codes_left: int


@router.get("/mfa", response_model=MfaStatus)
def mfa_status(ctx: Authed) -> MfaStatus:
    db, actor = ctx
    u = db.get(User, actor.id)
    assert u is not None
    left = db.execute(select(func.count()).select_from(MfaRecoveryCode).where(
        MfaRecoveryCode.user_id == u.id, MfaRecoveryCode.used_at.is_(None))).scalar_one()
    return MfaStatus(enabled=bool(u.totp_enabled_at), recovery_codes_left=left)


class MfaSetupOut(BaseModel):
    secret: str
    otpauth_uri: str
    qr_svg: str


@router.post("/mfa/setup", response_model=MfaSetupOut)
def mfa_setup(ctx: Authed) -> MfaSetupOut:
    """Start enrolment: a new secret is stored (encrypted) but not active until a code is confirmed."""
    db, actor = ctx
    u = db.get(User, actor.id)
    assert u is not None
    if u.totp_enabled_at:
        raise Conflict("Two-step verification is already on. Turn it off first to reset it.", code="mfa_enabled")
    secret = sec.new_totp_secret()
    u.totp_secret_enc = sec.encrypt(secret)
    u.totp_last_step = None
    db.commit()
    uri = sec.provisioning_uri(secret, u.email)
    return MfaSetupOut(secret=secret, otpauth_uri=uri, qr_svg=sec.qr_svg(uri))


class CodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=10)


class RecoveryCodesOut(BaseModel):
    recovery_codes: list[str]


@router.post("/mfa/enable", response_model=RecoveryCodesOut)
def mfa_enable(body: CodeIn, ctx: Authed) -> RecoveryCodesOut:
    db, actor = ctx
    sec.rate_limit(db, f"mfa-enable:{actor.id}", 10, 300)
    u = db.get(User, actor.id)
    assert u is not None
    if u.totp_enabled_at or not u.totp_secret_enc:
        raise Conflict("Start set-up first.", code="mfa_not_started")
    if not sec.verify_totp(u, body.code):
        raise ValidationFailed("That code didn't match. Check the time on your phone and try again.",
                               fields={"code": "Incorrect code"})
    u.totp_enabled_at = datetime.now(UTC)
    codes = sec.new_recovery_codes(db, u.id)
    u.token_version += 1  # re-authenticate other sessions under the stronger policy
    db.add(AuditEvent(user_id=u.id, action="auth.mfa_enabled"))
    db.commit()
    return RecoveryCodesOut(recovery_codes=codes)


class MfaDisableIn(BaseModel):
    password: str = Field(max_length=128)
    code: str = Field(min_length=6, max_length=20)


@router.post("/mfa/disable", status_code=204)
def mfa_disable(body: MfaDisableIn, ctx: Authed) -> None:
    db, actor = ctx
    sec.rate_limit(db, f"mfa-disable:{actor.id}", 10, 300)
    u = db.get(User, actor.id)
    assert u is not None
    if not u.totp_enabled_at:
        return
    code_ok = sec.verify_totp(u, body.code) if body.code.strip().isdigit() else sec.use_recovery_code(db, u.id, body.code)
    if not verify_password(u.password_hash, body.password) or not code_ok:
        raise ValidationFailed("Password or code is incorrect.", fields={"code": "Check password and code"})
    u.totp_enabled_at, u.totp_secret_enc, u.totp_last_step = None, None, None
    db.execute(text("delete from mfa_recovery_codes where user_id = :u"), {"u": u.id})
    db.add(AuditEvent(user_id=u.id, action="auth.mfa_disabled"))
    db.commit()


# ------------------------------------------------------------------ Sign in with Google
class GoogleStartIn(BaseModel):
    redirect_uri: str = Field(max_length=500)


class GoogleStartOut(BaseModel):
    url: str
    state: str
    nonce: str
    verifier: str


def _google_redirect_ok(uri: str) -> str:
    """Only our own callback may receive Google's code (no open redirect)."""
    s = get_settings()
    origins = {o.strip().rstrip("/") for o in [s.web_url, *s.allowed_origins.split(",")] if o.strip()}
    if uri not in {o + "/api/session/google/callback" for o in origins}:
        raise ValidationFailed("Invalid redirect address.", code="google_bad_redirect")
    return uri


@router.get("/google/enabled")
def google_enabled() -> dict[str, bool]:
    from ..services import google_auth
    return {"enabled": google_auth.enabled()}


@router.post("/google/start", response_model=GoogleStartOut, dependencies=[Depends(auth_rate_limit)])
def google_start(body: GoogleStartIn) -> GoogleStartOut:
    from ..services import google_auth
    st = google_auth.start(_google_redirect_ok(body.redirect_uri))
    return GoogleStartOut(url=st.url, state=st.state, nonce=st.nonce, verifier=st.verifier)


class GoogleCallbackIn(BaseModel):
    code: str = Field(min_length=10, max_length=2000)
    verifier: str = Field(min_length=32, max_length=200)
    nonce: str = Field(min_length=16, max_length=200)
    redirect_uri: str = Field(max_length=500)
    client: Literal["web"] = "web"
    timezone: str = Field(default="UTC", max_length=64)

    @field_validator("timezone")
    @classmethod
    def _tz(cls, v: str) -> str:
        try:
            return _valid_tz(v)
        except ValueError:
            return "UTC"


@router.post("/google/callback", response_model=TokenOut | MfaChallengeOut, dependencies=[Depends(auth_rate_limit)])
def google_callback(body: GoogleCallbackIn, db: PublicDb) -> TokenOut | MfaChallengeOut:
    """Finish Google sign-in: verify Google's ID token, then sign in, link or create the account."""
    import secrets as _secrets

    from ..services import google_auth
    g = google_auth.exchange(body.code, body.verifier, _google_redirect_ok(body.redirect_uri), body.nonce)
    sec.rate_limit(db, f"login-email:{g.email}", 20, 3600)
    user = db.execute(select(User).where(User.google_sub == g.sub).with_for_update()).scalar_one_or_none()
    created = False
    if user is None:
        user = db.execute(select(User).where(func.lower(User.email) == g.email).with_for_update()).scalar_one_or_none()
        if user is not None and user.deleted_at is None:
            if user.google_sub and user.google_sub != g.sub:
                raise Conflict("This email is linked to a different Google account.", code="google_conflict")
            if user.email_verified_at is None:
                # Someone may have registered this address without owning it: Google has now proved who owns
                # it, so the unproven password and any sessions it created stop working.
                user.password_hash = hash_password(_secrets.token_urlsafe(32))
                user.token_version += 1
                db.execute(update(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
                           .values(revoked_at=datetime.now(UTC)))
                user.email_verified_at = datetime.now(UTC)
            user.google_sub = g.sub
            db.add(AuditEvent(user_id=user.id, action="auth.google_linked"))
    if user is None:
        user = User(email=g.email, password_hash=hash_password(_secrets.token_urlsafe(32)), display_name=g.name,
                    timezone=body.timezone, google_sub=g.sub, email_verified_at=datetime.now(UTC),
                    is_admin=g.email in get_settings().admin_email_set)
        db.add(user)
        db.flush()
        db.add(Profile(user_id=user.id))
        db.add(AuditEvent(user_id=user.id, action="account.registered", meta={"method": "google"}))
        created = True
    if user.deleted_at is not None:
        raise Unauthorized("This account was deleted.", code="invalid_credentials")
    sec.check_not_locked(user)
    sec.record_success(user)
    if user.totp_enabled_at:
        db.commit()
        token, exp = issue_mfa_token(user, body.client)
        return MfaChallengeOut(mfa_token=token, expires_in=exp)
    if not created:
        db.add(AuditEvent(user_id=user.id, action="auth.login", meta={"client": body.client, "method": "google"}))
    return _tokens(db, user, body.client)

"""Account security: verification, reset, lockout, TOTP 2-step, verified-email gate, metrics, storage."""

from __future__ import annotations

import uuid

import pyotp
import pytest

PW = "correct horse battery"


@pytest.fixture
def outbox(monkeypatch):
    """Capture emails at the sending boundary (no SMTP in tests)."""
    sent: list[tuple[str, str, str]] = []
    from elevate.services import email
    monkeypatch.setattr(email, "send_verification", lambda to, tok: sent.append(("verify", to, tok)) or True)
    monkeypatch.setattr(email, "send_password_reset", lambda to, tok: sent.append(("reset", to, tok)) or True)
    return sent


def register(client, outbox=None):
    em = f"s-{uuid.uuid4().hex[:8]}@example.test"
    r = client.post("/api/v1/auth/register", json={"email": em, "password": PW})
    assert r.status_code == 201, r.text
    return em, r.json()


def test_email_verification_single_use(client, outbox):
    em, reg = register(client)
    kind, to, token = outbox[-1]
    assert kind == "verify" and to == em
    h = {"Authorization": f"Bearer {reg['access_token']}"}
    assert client.get("/api/v1/me", headers=h).json()["user"]["email_verified"] is False
    assert client.post("/api/v1/auth/verify-email", json={"token": token}).status_code == 204
    assert client.get("/api/v1/me", headers=h).json()["user"]["email_verified"] is True
    again = client.post("/api/v1/auth/verify-email", json={"token": token})
    assert again.status_code == 422 and again.json()["error"]["code"] == "invalid_link"


def test_password_reset_no_enumeration_and_revokes_sessions(client, outbox):
    em, reg = register(client)
    unknown = client.post("/api/v1/auth/forgot-password", json={"email": "nobody-here@example.test"})
    known = client.post("/api/v1/auth/forgot-password", json={"email": em})
    assert unknown.status_code == known.status_code == 202
    assert unknown.json() == known.json()  # identical response
    token = next(t for k, to, t in outbox if k == "reset" and to == em)
    assert client.post("/api/v1/auth/reset-password", json={"token": token, "new_password": "brand new password 1"}).status_code == 204
    # old access + refresh tokens are dead
    assert client.get("/api/v1/me", headers={"Authorization": f"Bearer {reg['access_token']}"}).status_code == 401
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": reg["refresh_token"]}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"email": em, "password": PW}).status_code == 401
    assert client.post("/api/v1/auth/login", json={"email": em, "password": "brand new password 1"}).status_code == 200
    # token is single use
    assert client.post("/api/v1/auth/reset-password", json={"token": token, "new_password": "another password 22"}).status_code == 422


def test_lockout_after_repeated_failures(client, outbox):
    em, _ = register(client)
    for _ in range(5):
        assert client.post("/api/v1/auth/login", json={"email": em, "password": "wrong password!!"}).status_code == 401
    locked = client.post("/api/v1/auth/login", json={"email": em, "password": PW})
    assert locked.status_code == 429 and locked.json()["error"]["code"] == "account_locked"
    # an address with no account behaves identically (no account enumeration via lockout)
    ghost = f"ghost-{uuid.uuid4().hex[:8]}@example.test"
    for _ in range(5):
        assert client.post("/api/v1/auth/login", json={"email": ghost, "password": "wrong password!!"}).status_code == 401
    g = client.post("/api/v1/auth/login", json={"email": ghost, "password": "wrong password!!"})
    assert g.status_code == 429 and g.json()["error"] == {**g.json()["error"], "code": "account_locked"}
    assert g.json()["error"]["message"] == locked.json()["error"]["message"]


def test_totp_two_step_login_replay_and_recovery(client, outbox):
    em, reg = register(client)
    h = {"Authorization": f"Bearer {reg['access_token']}"}
    setup = client.post("/api/v1/auth/mfa/setup", headers=h).json()
    assert setup["otpauth_uri"].startswith("otpauth://totp/") and "<svg" in setup["qr_svg"]
    totp = pyotp.TOTP(setup["secret"])
    bad = client.post("/api/v1/auth/mfa/enable", json={"code": "000000"}, headers=h)
    assert bad.status_code == 422
    used = totp.now()  # keep this exact code: a new 30 s window could start before the replay below
    codes = client.post("/api/v1/auth/mfa/enable", json={"code": used}, headers=h).json()["recovery_codes"]
    assert len(codes) == 10
    # enabling MFA revoked the old session's access token
    assert client.get("/api/v1/me", headers=h).status_code == 401
    step1 = client.post("/api/v1/auth/login", json={"email": em, "password": PW}).json()
    assert step1["mfa_required"] is True and "access_token" not in step1
    # the code used for enabling cannot be replayed
    replay = client.post("/api/v1/auth/login/mfa", json={"mfa_token": step1["mfa_token"], "code": used})
    assert replay.status_code == 401
    ok = client.post("/api/v1/auth/login/mfa", json={"mfa_token": step1["mfa_token"], "code": codes[0]})
    assert ok.status_code == 200 and ok.json()["access_token"]
    step1b = client.post("/api/v1/auth/login", json={"email": em, "password": PW}).json()
    reused = client.post("/api/v1/auth/login/mfa", json={"mfa_token": step1b["mfa_token"], "code": codes[0]})
    assert reused.status_code == 401  # recovery codes are single use
    # an mfa token is not an access token
    assert client.get("/api/v1/me", headers={"Authorization": f"Bearer {step1b['mfa_token']}"}).status_code == 401
    h2 = {"Authorization": f"Bearer {ok.json()['access_token']}"}
    assert client.get("/api/v1/auth/mfa", headers=h2).json() == {"enabled": True, "recovery_codes_left": 9}
    assert client.post("/api/v1/auth/mfa/disable", json={"password": PW, "code": codes[1]}, headers=h2).status_code == 204
    plain = client.post("/api/v1/auth/login", json={"email": em, "password": PW}).json()
    assert "access_token" in plain


def test_verified_email_gate_for_ai(client, outbox):
    from elevate.config import get_settings
    s = get_settings()
    em, reg = register(client)
    h = {"Authorization": f"Bearer {reg['access_token']}"}
    text = "Backend Engineer\n\nRequirements\n- Strong SQL skills.\n- Python experience is required for this role.\n" * 3
    s.require_verified_email = True
    try:
        r = client.post("/api/v1/jobs/capture", json={"method": "manual", "text": text}, headers=h)
        assert r.status_code == 403 and r.json()["error"]["code"] == "email_unverified"
        # non-AI features keep working
        assert client.get("/api/v1/jobs", headers=h).status_code == 200
        token = next(t for k, to, t in outbox if k == "verify" and to == em)
        client.post("/api/v1/auth/verify-email", json={"token": token})
        assert client.post("/api/v1/jobs/capture", json={"method": "manual", "text": text}, headers=h).status_code == 202
    finally:
        s.require_verified_email = False


def test_metrics_requires_token(client):
    assert client.get("/metrics").status_code == 404
    assert client.get("/metrics", headers={"Authorization": "Bearer wrong"}).status_code == 404
    r = client.get("/metrics", headers={"Authorization": "Bearer test-metrics-token-0123456789abcdef"})
    assert r.status_code == 200 and "elevate_queue_oldest_seconds" in r.text and "@" not in r.text


def test_storage_rejects_path_tricks():
    from elevate.errors import ValidationFailed
    from elevate.services.storage import LocalStorage
    st = LocalStorage()
    for bad in ("../../etc/passwd", "a.bin", "..\\x.bin", "0" * 31 + ".bin"):
        with pytest.raises(ValidationFailed):
            st.get(uuid.uuid4(), bad)


def test_production_guard_refuses_unsafe_config(monkeypatch):
    from elevate.config import Settings
    monkeypatch.setenv("ELEVATE_ENV", "production")
    monkeypatch.setenv("ELEVATE_DATA_KEY", "")
    monkeypatch.setenv("ELEVATE_METRICS_TOKEN", "")
    monkeypatch.setenv("ELEVATE_JWT_SECRET", "SECRET-CANARY-" + "x" * 40)
    with pytest.raises(ValueError) as e:
        Settings()
    msg = str(e.value)
    assert "SECRET-CANARY" not in msg and "input_value" not in msg  # secrets never echoed into logs
    for needle in ("must be https", "Fernet", "EMAIL_BACKEND=smtp", "STORAGE_BACKEND=s3", "METRICS_TOKEN"):
        assert needle in msg

"""Sign in with Google: ID-token verification and account create / link / takeover protection."""

from __future__ import annotations

import time
import uuid

import jwt
import pyotp
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from elevate.config import get_settings
from elevate.services import google_auth

PW = "correct horse battery"
CB = "http://localhost:3000/api/session/google/callback"


@pytest.fixture
def google(monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "google_client_id", "cid.apps.googleusercontent.com")
    monkeypatch.setattr(s, "google_client_secret", "test-secret")
    monkeypatch.setattr(s, "web_url", "http://localhost:3000")
    return s


@pytest.fixture
def signer(monkeypatch, google):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)

    class Keys:
        def get_signing_key_from_jwt(self, _t):
            return type("K", (), {"key": key.public_key()})()

    monkeypatch.setattr(google_auth, "_keys", lambda: Keys())

    def make(**over):
        now = int(time.time())
        claims = {"iss": "https://accounts.google.com", "aud": google.google_client_id, "sub": "g-123", "iat": now,
                  "exp": now + 600, "nonce": "n" * 20, "email": "Ana@Example.test", "email_verified": True, "name": "Ana"}
        claims.update(over)
        return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm="RS256")
    return make


def test_id_token_checks(signer):
    u = google_auth.verify_id_token(signer(), "n" * 20)
    assert (u.sub, u.email, u.name) == ("g-123", "ana@example.test", "Ana")
    for bad, code in [(dict(aud="someone-else"), "google_invalid_token"), (dict(iss="https://evil.test"), "google_invalid_token"),
                      (dict(exp=int(time.time()) - 3600), "google_invalid_token"), (dict(nonce="x" * 20), "google_invalid_token"),
                      (dict(email_verified=False), "google_email_unverified")]:
        with pytest.raises(Exception) as e:
            google_auth.verify_id_token(signer(**bad), "n" * 20)
        assert getattr(e.value, "code", "") == code, bad


def test_start_uses_pkce_and_only_our_callback(client, google):
    r = client.post("/api/v1/auth/google/start", json={"redirect_uri": CB})
    assert r.status_code == 200
    j = r.json()
    assert "code_challenge_method=S256" in j["url"] and f"state={j['state']}" in j["url"] and len(j["verifier"]) >= 32
    bad = client.post("/api/v1/auth/google/start", json={"redirect_uri": "https://evil.test/api/session/google/callback"})
    assert bad.status_code == 422


def _login(client, monkeypatch, sub, email, name="Ana"):
    monkeypatch.setattr(google_auth, "exchange", lambda code, v, ru, n: google_auth.GoogleUser(sub=sub, email=email, name=name))
    return client.post("/api/v1/auth/google/callback", json={"code": "c" * 20, "verifier": "v" * 43, "nonce": "n" * 20,
                                                             "redirect_uri": CB})


def test_new_google_user_is_created_verified(client, google, monkeypatch):
    em = f"g-{uuid.uuid4().hex[:8]}@example.test"
    r = _login(client, monkeypatch, f"sub-{em}", em)
    assert r.status_code == 200, r.text
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    assert client.get("/api/v1/me", headers=h).json()["user"]["email_verified"] is True
    again = _login(client, monkeypatch, f"sub-{em}", em)  # same Google account -> same user
    assert again.json()["user"]["id"] == r.json()["user"]["id"]


def test_links_existing_verified_account_and_keeps_password(client, google, monkeypatch):
    em = f"p-{uuid.uuid4().hex[:8]}@example.test"
    sent: list[str] = []
    from elevate.services import email
    monkeypatch.setattr(email, "send_verification", lambda to, tok: sent.append(tok) or True)
    reg = client.post("/api/v1/auth/register", json={"email": em, "password": PW}).json()
    assert client.post("/api/v1/auth/verify-email", json={"token": sent[-1]}).status_code == 204  # the user owns the address
    r = _login(client, monkeypatch, f"sub-{em}", em)
    assert r.json()["user"]["id"] == reg["user"]["id"]
    assert client.post("/api/v1/auth/login", json={"email": em, "password": PW}).status_code == 200
    other = _login(client, monkeypatch, "another-google-account", em)
    assert other.status_code == 409 and other.json()["error"]["code"] == "google_conflict"


def test_unverified_squatter_loses_access_when_owner_signs_in_with_google(client, google, monkeypatch):
    em = f"q-{uuid.uuid4().hex[:8]}@example.test"
    squat = client.post("/api/v1/auth/register", json={"email": em, "password": PW}).json()  # never verified
    r = _login(client, monkeypatch, f"sub-{em}", em)
    assert r.status_code == 200 and r.json()["user"]["id"] == squat["user"]["id"]
    assert client.post("/api/v1/auth/login", json={"email": em, "password": PW}).status_code == 401
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": squat["refresh_token"]}).status_code == 401
    assert client.get("/api/v1/me", headers={"Authorization": f"Bearer {squat['access_token']}"}).status_code == 401


def test_two_step_verification_still_required(client, google, monkeypatch):
    em = f"m-{uuid.uuid4().hex[:8]}@example.test"
    first = _login(client, monkeypatch, f"sub-{em}", em).json()
    h = {"Authorization": f"Bearer {first['access_token']}"}
    secret = client.post("/api/v1/auth/mfa/setup", headers=h).json()["secret"]
    assert client.post("/api/v1/auth/mfa/enable", json={"code": pyotp.TOTP(secret).now()}, headers=h).status_code == 200
    r = _login(client, monkeypatch, f"sub-{em}", em).json()
    assert r.get("mfa_required") is True and "access_token" not in r


def test_disabled_without_keys(client, monkeypatch):
    s = get_settings()
    monkeypatch.setattr(s, "google_client_id", "")
    assert client.get("/api/v1/auth/google/enabled").json() == {"enabled": False}
    r = client.post("/api/v1/auth/google/start", json={"redirect_uri": CB})
    assert r.status_code == 503 and r.json()["error"]["code"] == "google_disabled"

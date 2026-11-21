"""Sign in with Google (OpenID Connect, authorization-code flow with PKCE).

The browser never sees the client secret or Google's tokens: the web app sends the one-time code here, this
service exchanges it with Google over TLS, then verifies the ID token's signature (Google's published keys),
issuer, audience, expiry, nonce and that the email is verified. Only the Google account ID ("sub") is stored.
"""

from __future__ import annotations

import base64
import hashlib
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx
import jwt

from ..config import get_settings
from ..errors import CapabilityUnavailable, Unauthorized

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"  # noqa: S105 - a URL, not a secret
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")

_jwks: jwt.PyJWKClient | None = None


def enabled() -> bool:
    s = get_settings()
    return bool(s.google_client_id and s.google_client_secret)


def _require() -> tuple[str, str]:
    s = get_settings()
    if not enabled():
        raise CapabilityUnavailable("Google sign-in isn't set up on this server.", code="google_disabled")
    return s.google_client_id, s.google_client_secret


@dataclass
class Start:
    url: str
    state: str
    nonce: str
    verifier: str


def start(redirect_uri: str) -> Start:
    """Authorization URL plus the one-time values the web app keeps in a short-lived HttpOnly cookie."""
    client_id, _ = _require()
    state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    q = {"client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code", "scope": "openid email profile",
         "state": state, "nonce": nonce, "code_challenge": challenge, "code_challenge_method": "S256",
         "prompt": "select_account", "access_type": "online"}
    return Start(url=f"{AUTH_URL}?{urlencode(q)}", state=state, nonce=nonce, verifier=verifier)


@dataclass
class GoogleUser:
    sub: str
    email: str
    name: str | None


def _keys() -> jwt.PyJWKClient:
    global _jwks
    if _jwks is None:
        _jwks = jwt.PyJWKClient(JWKS_URL, cache_keys=True, lifespan=3600, timeout=10)
    return _jwks


def verify_id_token(id_token: str, nonce: str) -> GoogleUser:
    client_id, _ = _require()
    try:
        key = _keys().get_signing_key_from_jwt(id_token)
        claims: dict[str, Any] = jwt.decode(id_token, key.key, algorithms=["RS256"], audience=client_id,
                                            options={"require": ["iss", "aud", "exp", "iat", "sub"]}, leeway=60)
    except jwt.PyJWKClientError as e:
        raise CapabilityUnavailable("Couldn't reach Google to check the sign-in. Try again.", code="google_unreachable",
                                    retryable=True) from e
    except jwt.InvalidTokenError as e:
        raise Unauthorized("Google sign-in couldn't be verified. Try again.", code="google_invalid_token") from e
    if claims.get("iss") not in ISSUERS:
        raise Unauthorized("Google sign-in couldn't be verified. Try again.", code="google_invalid_token")
    if not nonce or not secrets.compare_digest(str(claims.get("nonce", "")), nonce):
        raise Unauthorized("This Google sign-in expired. Start again.", code="google_invalid_token")
    email = str(claims.get("email") or "").strip().lower()
    if not email or claims.get("email_verified") is not True:
        raise Unauthorized("Your Google account's email isn't verified, so it can't be used to sign in.",
                           code="google_email_unverified")
    name = claims.get("name")
    return GoogleUser(sub=str(claims["sub"])[:64], email=email[:320], name=str(name)[:120] if name else None)


def exchange(code: str, verifier: str, redirect_uri: str, nonce: str) -> GoogleUser:
    client_id, client_secret = _require()
    try:
        r = httpx.post(TOKEN_URL, timeout=15, data={
            "code": code, "client_id": client_id, "client_secret": client_secret, "redirect_uri": redirect_uri,
            "grant_type": "authorization_code", "code_verifier": verifier})
    except httpx.HTTPError as e:
        raise CapabilityUnavailable("Couldn't reach Google. Try again.", code="google_unreachable", retryable=True) from e
    if r.status_code != 200:
        raise Unauthorized("Google sign-in failed or expired. Start again.", code="google_code_rejected")
    id_token = (r.json() or {}).get("id_token")
    if not isinstance(id_token, str):
        raise Unauthorized("Google didn't return a sign-in token. Start again.", code="google_code_rejected")
    return verify_id_token(id_token, nonce)

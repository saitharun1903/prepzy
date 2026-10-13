"""Free-hosting profile: database file storage (RLS), the OpenAI-compatible provider (Groq), the
embedded worker, and the production guard for that configuration."""

from __future__ import annotations

import json
import time
import uuid

import httpx
import pytest

from tests.test_integration import RESUME, _resume_docx


@pytest.fixture
def db_storage(monkeypatch, migrated):
    from elevate.services import storage
    st = storage.DbStorage()
    monkeypatch.setattr(storage, "get_storage", lambda: st)
    return st


def test_db_storage_is_owner_scoped(client, user, db_storage):
    from sqlalchemy import text

    from elevate.db import user_session
    from elevate.errors import NotFound, ValidationFailed
    owner = uuid.UUID(user["id"])
    name = uuid.uuid4().hex + ".bin"
    db_storage.put(owner, name, b"resume bytes")
    db_storage.put(owner, name, b"resume bytes v2")  # overwrite is idempotent
    assert db_storage.get(owner, name) == b"resume bytes v2"
    # Another user's RLS context cannot see the row, even with a raw query.
    with user_session(uuid.uuid4()) as db:
        assert db.execute(text("select count(*) from stored_files")).scalar() == 0
    with pytest.raises(NotFound):
        db_storage.get(uuid.uuid4(), name)
    with pytest.raises(ValidationFailed):
        db_storage.get(owner, "../x.bin")
    db_storage.delete(owner, name)
    with pytest.raises(NotFound):
        db_storage.get(owner, name)
    db_storage.put(owner, name, b"x")
    db_storage.delete_owner(owner)
    with pytest.raises(NotFound):
        db_storage.get(owner, name)


def test_embedded_worker_processes_upload_with_db_storage(client, user, db_storage):
    from elevate.worker import start_embedded
    data = _resume_docx(RESUME)
    r = client.post("/api/v1/resumes/upload", headers=user["h"], files={"file": ("cv.docx", data)},
                    data={"name": "CV"})
    assert r.status_code == 202, r.text
    op_id = r.json()["operation_id"]
    stop = start_embedded()
    try:
        state = None
        for _ in range(100):
            state = client.get(f"/api/v1/operations/{op_id}", headers=user["h"]).json()["state"]
            if state in ("succeeded", "failed", "cancelled", "timed_out"):
                break
            time.sleep(0.2)
    finally:
        stop.set()
    assert state == "succeeded"
    # The parse read the file back from Postgres; the download serves the same bytes.
    rid, vid = r.json()["resume_id"], r.json()["version_id"]
    dl = client.get(f"/api/v1/resumes/{rid}/versions/{vid}/file", headers=user["h"])
    assert dl.status_code == 200 and dl.content == data


def _provider(monkeypatch, handler, model="openai/gpt-oss-120b"):
    from elevate.services import llm
    real = httpx.Client
    monkeypatch.setattr(llm.httpx, "Client", lambda **kw: real(transport=httpx.MockTransport(handler), **kw))
    p = llm.OpenAICompatProvider()
    p.base, p.key, p.model = "https://api.groq.test/openai/v1", "test-key", model
    return p


def test_openai_compatible_provider_json_mode(monkeypatch):
    seen: dict = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen["auth"] = req.headers["authorization"]
        seen["body"] = json.loads(req.content)
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"answer": 42}'}}],
                                         "usage": {"prompt_tokens": 10, "completion_tokens": 3}})

    p = _provider(monkeypatch, handler)
    out = p.generate_json("sys", "user text", {"type": "object", "properties": {"answer": {"type": "integer"}}})
    assert out.data == {"answer": 42} and out.prompt_tokens == 10 and out.output_tokens == 3
    body = seen["body"]
    assert seen["auth"] == "Bearer test-key"
    assert body["response_format"] == {"type": "json_object"} and body["reasoning_effort"] == "low"
    assert '"answer"' in body["messages"][0]["content"]  # schema travels in the system prompt


@pytest.mark.parametrize(("status", "body", "code", "retryable"), [
    (429, "rate limit", "model_rate_limited", True),
    (413, "too large", "input_too_large", False),
    (401, "bad key", "model_auth", False),
    (404, "no model", "model_missing", False),
])
def test_openai_compatible_provider_errors(monkeypatch, status, body, code, retryable):
    from elevate.errors import CapabilityUnavailable
    p = _provider(monkeypatch, lambda _req: httpx.Response(status, text=body))
    with pytest.raises(CapabilityUnavailable) as e:
        p.generate_json("s", "u", {"type": "object"})
    assert e.value.code == code and e.value.retryable is retryable


def test_openai_compatible_provider_bad_json_and_no_embeddings(monkeypatch):
    from elevate.errors import CapabilityUnavailable, ModelOutputInvalid
    p = _provider(monkeypatch, lambda _r: httpx.Response(200, json={"choices": [{"message": {"content": "not json"}}]}))
    with pytest.raises(ModelOutputInvalid):
        p.generate_json("s", "u", {"type": "object"})
    with pytest.raises(CapabilityUnavailable):
        p.embed(["x"])
    assert p.health()["embed_installed"] is False


def test_production_guard_free_profile(monkeypatch):
    from cryptography.fernet import Fernet

    from elevate.config import Settings
    base = {
        "ELEVATE_ENV": "production", "ELEVATE_WEB_URL": "https://elevate-web.onrender.com",
        "ELEVATE_ALLOWED_ORIGINS": "https://elevate-web.onrender.com",
        "ELEVATE_DATABASE_URL": "postgresql+psycopg://a:b@ep-x.neon.tech/db?sslmode=require",
        "ELEVATE_JWT_SECRET": "j" * 64, "ELEVATE_DATA_KEY": Fernet.generate_key().decode(),
        "ELEVATE_EMAIL_BACKEND": "smtp", "ELEVATE_SMTP_HOST": "smtp.example.test",
        "ELEVATE_METRICS_TOKEN": "m" * 32, "ELEVATE_STORAGE_BACKEND": "db", "ELEVATE_LLM_PROVIDER": "openai",
        "ELEVATE_OPENAI_API_KEY": "GROQ-KEY-CANARY",
    }
    for k, v in base.items():
        monkeypatch.setenv(k, v)
    s = Settings()
    assert s.storage_backend == "db" and s.llm_provider == "openai"
    monkeypatch.setenv("ELEVATE_OPENAI_API_KEY", "")
    with pytest.raises(ValueError) as e:
        Settings()
    assert "OPENAI_API_KEY" in str(e.value) and "GROQ-KEY-CANARY" not in str(e.value)


def test_brevo_email_backend(monkeypatch):
    from elevate.config import get_settings
    from elevate.services import email
    sent: dict = {}

    def fake_post(url, json, timeout, headers):  # noqa: A002 - mirrors httpx.post's signature
        sent.update(url=url, body=json, key=headers["api-key"])
        return httpx.Response(201, json={"messageId": "<x@brevo>"})

    s = get_settings()
    monkeypatch.setattr(s, "email_backend", "brevo")
    monkeypatch.setattr(s, "brevo_api_key", "test-brevo-key")
    monkeypatch.setattr(s, "email_from", "Elevate <sender@example.test>")
    monkeypatch.setattr(email.httpx, "post", fake_post)
    assert email.send_verification("person@example.test", "tok123") is True
    assert sent["url"] == "https://api.brevo.com/v3/smtp/email" and sent["key"] == "test-brevo-key"
    assert sent["body"]["sender"] == {"name": "Elevate", "email": "sender@example.test"}
    assert sent["body"]["to"] == [{"email": "person@example.test"}] and "tok123" in sent["body"]["textContent"]
    # A rejection (e.g. unverified sender) is reported, never raised into the sign-up request.
    monkeypatch.setattr(email.httpx, "post", lambda *a, **k: httpx.Response(400, json={"message": "sender not valid"}))
    assert email.send_verification("person@example.test", "tok123") is False


def test_me_reports_email_delivery_for_brevo(client, user, monkeypatch):
    """The hosted profile sends mail through Brevo; the UI must not claim delivery isn't set up."""
    from elevate.config import get_settings
    s = get_settings()
    for backend, delivers in (("brevo", True), ("smtp", True), ("console", False)):
        monkeypatch.setattr(s, "email_backend", backend)
        me = client.get("/api/v1/me", headers=user["h"]).json()
        assert me["account_security"]["email_delivery"] is delivers, backend

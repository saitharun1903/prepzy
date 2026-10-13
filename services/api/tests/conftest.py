"""Integration fixtures: an ISOLATED database `elevate_test` (same local server, separate DB),
migrated with Alembic from scratch, accessed through the real least-privilege runtime role so
RLS is exercised. The LLM is replaced only at the provider interface (explicit test boundary)."""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _env(key: str) -> str | None:
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1]
    return None


def _swap_db(url: str, name: str) -> str:
    return re.sub(r"/[^/?]+(\?|$)", f"/{name}\\1", url, count=1) if url.count("/") >= 3 else url


OWNER_URL = _env("ELEVATE_MIGRATION_DATABASE_URL") or ""
APP_URL = _env("ELEVATE_DATABASE_URL") or ""
TEST_DB = "elevate_test"
_DATA = tempfile.mkdtemp(prefix="elevate-test-")

os.environ.update({
    "ELEVATE_ENV": "test",
    "ELEVATE_DATABASE_URL": _swap_db(APP_URL, TEST_DB),
    "ELEVATE_MIGRATION_DATABASE_URL": _swap_db(OWNER_URL, TEST_DB),
    "ELEVATE_DATA_DIR": _DATA,
    "ELEVATE_AUTH_RATE_PER_MINUTE": "1000",
    "ELEVATE_WORKER_LEASE_SECONDS": "15",
    "ELEVATE_ADMIN_EMAILS": "admin@example.test",
})


def _db_available() -> bool:
    if not OWNER_URL:
        return False
    from sqlalchemy import create_engine, text
    try:
        eng = create_engine(_swap_db(OWNER_URL, "postgres"), isolation_level="AUTOCOMMIT")
        with eng.connect() as c:
            c.execute(text(f"drop database if exists {TEST_DB} with (force)"))
            c.execute(text(f"create database {TEST_DB}"))
        eng.dispose()
        return True
    except Exception as e:  # noqa: BLE001 - report as skip reason
        print("integration DB unavailable:", e, file=sys.stderr)
        return False


@pytest.fixture(scope="session")
def migrated() -> None:
    if not _db_available():
        pytest.skip("BLOCKED: local PostgreSQL (docker compose) not reachable")
    env = {**os.environ, "ELEVATE_MIGRATION_URL_OVERRIDE": os.environ["ELEVATE_MIGRATION_DATABASE_URL"]}
    r = subprocess.run(["uv", "run", "alembic", "upgrade", "head"], cwd=ROOT / "services" / "api", env=env,
                       capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    from sqlalchemy import create_engine, text
    eng = create_engine(os.environ["ELEVATE_MIGRATION_DATABASE_URL"])
    with eng.begin() as c:
        c.execute(text("grant usage on schema public to elevate_app"))
        c.execute(text("grant select, insert, update, delete on all tables in schema public to elevate_app"))
        c.execute(text("grant usage, select on all sequences in schema public to elevate_app"))
    eng.dispose()


class FakeLLM:
    """Deterministic provider for tests: echoes requirement bullets from the prompt."""

    model = "fake-llm"

    def __init__(self) -> None:
        self.calls = 0

    def generate_json(self, system: str, user: str, schema: dict, **_: object):
        from elevate.services.llm import Completion
        self.calls += 1
        props = schema.get("properties", {})
        if "requirements" in props:
            body = user.split("<job_posting>", 1)[-1]
            lines = [ln.strip(" -") for ln in body.splitlines() if ln.strip().startswith("-")]
            reqs = [{"quote": ln, "category": "skill", "importance": "unclear"} for ln in lines]
            title = next((ln for ln in body.splitlines() if ln.strip() and "TEST FIXTURE" not in ln), "")
            data = {k: {"value": None, "quote": None} for k in props if k not in ("requirements", "responsibilities", "multiple_jobs")}
            data["title"] = {"value": title.strip(), "quote": title.strip()}
            data["salary"] = {"value": "USD 1,000,000", "quote": "USD 1,000,000"}  # invented -> must be dropped
            data.update({"requirements": reqs, "responsibilities": [], "multiple_jobs": False})
            return Completion(data, self.model, 5, None, None)
        if "questions" in props:
            kinds = props["questions"]["items"]["properties"]["kind"]["enum"]
            qs = [{"kind": k, "topic": "t", "prompt": f"Practice question about {k} number {i}", "requirement_key": None,
                   "extra_criteria": []} for i, k in enumerate(kinds * 3)]
            return Completion({"questions": qs}, self.model, 5, None, None)
        if "assessable" in props:
            ans = user.split("<answer>", 1)[-1].split("</answer>")[0].strip()
            crit = [ln[2:] for ln in user.splitlines() if ln.startswith("- ")]
            return Completion({"assessable": True, "criteria": [
                {"criterion": c, "rating": "partly", "answer_quote": ans[:20], "comment": "ok"} for c in crit] +
                [{"criterion": crit[0], "rating": "met", "answer_quote": "TEXT NOT IN ANSWER", "comment": ""}],
                "strengths": ["s"], "gaps": ["g"], "improvements": ["i"]}, self.model, 5, None, None)
        return Completion({}, self.model, 5, None, None)

    def embed(self, texts: list[str]) -> list[list[float]]:
        import hashlib
        out = []
        for t in texts:
            words = re.findall(r"[a-z]+", t.lower().split(":", 1)[-1])
            v = [0.0] * 768
            for w in words:
                v[int(hashlib.md5(w.encode()).hexdigest(), 16) % 768] += 1.0  # noqa: S324 - test-only bucketing
            n = sum(x * x for x in v) ** 0.5 or 1.0
            out.append([x / n for x in v])
        return out

    def health(self) -> dict:
        return {"reachable": True, "llm_installed": True, "embed_installed": True}


@pytest.fixture(scope="session")
def fake_llm(migrated) -> FakeLLM:
    from elevate.services import llm
    f = FakeLLM()
    llm.set_provider(f)
    return f


@pytest.fixture(scope="session")
def client(fake_llm):
    from fastapi.testclient import TestClient

    from elevate.main import app
    with TestClient(app) as c:
        yield c


@pytest.fixture
def user(client):
    import secrets
    email = f"u-{secrets.token_hex(5)}@example.test"
    r = client.post("/api/v1/auth/register", json={"email": email, "password": "correct horse battery"})
    assert r.status_code == 201, r.text
    data = r.json()
    return {"email": email, "token": data["access_token"], "refresh": data["refresh_token"], "id": data["user"]["id"],
            "h": {"Authorization": f"Bearer {data['access_token']}"}}


def run_worker_once(max_ops: int = 10) -> int:
    """Drive the real worker code path synchronously (claim -> run -> fenced commit)."""
    from elevate import handlers, handlers_more  # noqa: F401
    from elevate.db import system_session
    from elevate.services import operations as ops
    from elevate.worker import run_operation
    n = 0
    for _ in range(max_ops):
        with system_session() as db:
            op = ops.claim(db, "test-worker")
        if op is None:
            break
        run_operation(op, "test-worker")
        n += 1
    return n

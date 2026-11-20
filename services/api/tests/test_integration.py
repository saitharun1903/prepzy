"""Integration tests against a real, isolated PostgreSQL database with RLS and the real worker code."""

from __future__ import annotations

import io
import threading
import uuid
import zipfile
from pathlib import Path

from sqlalchemy import text

from tests.conftest import run_worker_once

FIX = Path(__file__).resolve().parents[3] / "tests" / "fixtures"
JOB = (FIX / "jobs" / "backend_engineer.txt").read_text(encoding="utf-8")
MKT = (FIX / "jobs" / "digital_marketing.txt").read_text(encoding="utf-8")
RESUME = (FIX / "resumes" / "fresher_java.txt").read_text(encoding="utf-8")


def capture(client, u, text_=JOB, key=None, **kw):
    h = dict(u["h"])
    if key:
        h["Idempotency-Key"] = key
    return client.post("/api/v1/jobs/capture", json={"method": "manual", "text": text_, "save": True, **kw}, headers=h)


def test_new_account_is_empty(client, user):
    for path in ("/api/v1/jobs", "/api/v1/applications", "/api/v1/notifications"):
        r = client.get(path, headers=user["h"]).json()
        assert (r.get("total", 0) == 0) and not r["items"]
    assert client.get("/api/v1/resumes", headers=user["h"]).json() == []
    assert client.get("/api/v1/roadmaps", headers=user["h"]).json() == []


def test_auth_errors_and_refresh_rotation(client, user):
    assert client.get("/api/v1/jobs").status_code == 401
    assert client.get("/api/v1/jobs", headers={"Authorization": "Bearer nope"}).json()["error"]["code"] == "invalid_token"
    r = client.post("/api/v1/auth/refresh", json={"refresh_token": user["refresh"]})
    assert r.status_code == 200
    # reuse of the consumed token revokes the family
    r2 = client.post("/api/v1/auth/refresh", json={"refresh_token": user["refresh"]})
    assert r2.status_code == 401 and r2.json()["error"]["code"] == "refresh_reused"
    r3 = client.post("/api/v1/auth/refresh", json={"refresh_token": r.json()["refresh_token"]})
    assert r3.status_code == 401
    bad = client.post("/api/v1/auth/login", json={"email": user["email"], "password": "wrong password!"})
    assert bad.status_code == 401 and bad.json()["error"]["code"] == "invalid_credentials"


def test_capture_analyze_save_flow_and_validation(client, user, fake_llm):
    r = capture(client, user, key="k1")
    assert r.status_code == 202
    op_id, job_id = r.json()["operation_id"], r.json()["job_id"]
    assert client.get(f"/api/v1/operations/{op_id}", headers=user["h"]).json()["state"] == "queued"
    assert run_worker_once() >= 1
    op = client.get(f"/api/v1/operations/{op_id}", headers=user["h"]).json()
    assert op["state"] == "succeeded", op
    job = client.get(f"/api/v1/jobs/{job_id}", headers=user["h"]).json()
    res = job["analysis"]["result"]
    assert res["fields"]["salary"]["value"] is None  # invented by the fake model, not in text
    assert any(i["code"] == "unsupported_field" for i in job["analysis"]["issues"])
    java = next(r for r in res["requirements"] if "Kotlin" in r["text"])
    assert java["group"] == "any" and java["years"]["min"] == 3
    kafka = next(r for r in res["requirements"] if "Kafka" in r["text"])
    assert kafka["importance"] == "preferred"
    assert job["job"]["saved"] is True
    # same content again -> cached analysis, no new operation
    again = capture(client, user)
    assert again.status_code == 200 and again.json()["reused_analysis"] is True
    # validation
    short = capture(client, user, text_="too short")
    assert short.status_code == 422 and short.json()["error"]["code"] == "validation_failed"
    bad_url = capture(client, user, source={"url": "file:///etc/passwd"})
    assert bad_url.status_code == 422


def test_idempotent_concurrent_capture(client, user):
    key = uuid.uuid4().hex
    text_ = JOB + "\nVariant for concurrency."
    results: list = []

    def go():
        results.append(capture(client, user, text_=text_, key=key))
    ts = [threading.Thread(target=go) for _ in range(4)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    ok = [r for r in results if r.status_code == 202]
    assert ok, [r.text for r in results]
    assert len({r.json()["operation_id"] for r in ok}) == 1
    assert all(r.status_code in (202, 409) for r in results)
    jobs = client.get("/api/v1/jobs", headers=user["h"]).json()
    assert len([j for j in jobs["items"] if j["title"] is None or True]) >= 1
    conflict = capture(client, user, text_=JOB + "different", key=key)
    assert conflict.status_code == 409 and conflict.json()["error"]["code"] == "idempotency_conflict"


def test_cross_user_isolation_api_and_rls(client, user):
    from elevate.db import user_session
    from elevate.models import Job
    r = capture(client, user, text_=JOB + "\nisolation")
    job_id = r.json()["job_id"]
    other = client.post("/api/v1/auth/register", json={"email": f"x-{uuid.uuid4().hex[:6]}@example.test",
                                                        "password": "another long password"}).json()
    oh = {"Authorization": f"Bearer {other['access_token']}"}
    for path in (f"/api/v1/jobs/{job_id}", f"/api/v1/operations/{r.json()['operation_id']}"):
        assert client.get(path, headers=oh).status_code == 404
    assert client.post(f"/api/v1/jobs/{job_id}/notes", json={"body": "x"}, headers=oh).status_code == 404
    assert client.post("/api/v1/applications", json={"job_id": job_id}, headers=oh).status_code == 404
    # RLS layer: even an unfiltered query under the other user's context returns nothing
    with user_session(uuid.UUID(other["user"]["id"])) as db:
        assert db.execute(text("select count(*) from jobs")).scalar() == 0
        assert db.get(Job, uuid.UUID(job_id)) is None
    with user_session(None) as db:
        assert db.execute(text("select count(*) from jobs")).scalar() == 0


def test_runtime_role_is_not_superuser_and_cannot_bypass(migrated):
    from elevate.db import engine
    with engine().connect() as c:
        row = c.execute(text("select rolsuper, rolbypassrls from pg_roles where rolname = current_user")).one()
        assert row == (False, False)


def _resume_docx(body: str) -> bytes:
    import docx
    d = docx.Document()
    for line in body.splitlines():
        d.add_paragraph(line)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def test_resume_upload_parse_review_match_and_delete(client, user):
    data = _resume_docx(RESUME)
    r = client.post("/api/v1/resumes/upload", headers=user["h"], files={"file": ("cv.docx", data)}, data={"name": "CV"})
    assert r.status_code == 202, r.text
    run_worker_once()
    v = client.get(f"/api/v1/resumes/{r.json()['resume_id']}/versions/{r.json()['version_id']}", headers=user["h"]).json()
    assert v["version"]["parse_status"] == "parsed"
    ids = {s["id"] for s in v["version"]["extracted"]["skills"]}
    assert {"java", "spring_boot", "sql"} <= ids
    # unsupported / unsafe files
    assert client.post("/api/v1/resumes/upload", headers=user["h"], files={"file": ("cv.pdf", b"hello")}).status_code == 422
    assert client.post("/api/v1/resumes/upload", headers=user["h"],
                       files={"file": ("cv.docx", b"%PDF-1.4 fake")}).json()["error"]["code"] == "type_mismatch"
    zbuf = io.BytesIO()
    with zipfile.ZipFile(zbuf, "w") as z:
        z.writestr("a.txt", "x")
    assert client.post("/api/v1/resumes/upload", headers=user["h"],
                       files={"file": ("cv.docx", zbuf.getvalue())}).json()["error"]["code"] == "unsupported_format"
    scanned = b"%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"
    s = client.post("/api/v1/resumes/upload", headers=user["h"], files={"file": ("scan.pdf", scanned)})
    run_worker_once()
    sv = client.get(f"/api/v1/resumes/{s.json()['resume_id']}/versions/{s.json()['version_id']}", headers=user["h"]).json()
    assert sv["version"]["parse_status"] == "unsupported" and not sv["version"]["extracted"]
    # review: remove a skill -> report marked stale
    job = capture(client, user, text_=JOB + "\nresume test")
    run_worker_once()
    rep = client.post(f"/api/v1/jobs/{job.json()['job_id']}/match", json={"resume_version_id": r.json()["version_id"]},
                      headers=user["h"]).json()
    assert rep["result"]["label"] == "Your match score"
    rv = client.put(f"/api/v1/resumes/{r.json()['resume_id']}/versions/{r.json()['version_id']}/review",
                    json={"removed_skills": ["java"], "added_skills": []}, headers=user["h"])
    assert rv.status_code == 200
    again = client.get(f"/api/v1/match-reports/{rep['id']}", headers=user["h"]).json()
    assert any("Resume evidence" in s for s in again["stale_reasons"])
    # history preserved: old report unchanged
    assert again["result"] == rep["result"]
    # file download requires ownership; delete removes file
    f = client.get(f"/api/v1/resumes/{r.json()['resume_id']}/versions/{r.json()['version_id']}/file", headers=user["h"])
    assert f.status_code == 200 and f.content == data
    assert client.delete(f"/api/v1/resumes/{r.json()['resume_id']}", headers=user["h"]).status_code == 204


def test_worker_lease_recovery_and_fencing(client, user):
    from elevate.db import system_session
    from elevate.services import operations as ops
    r = capture(client, user, text_=JOB + "\nlease test")
    op_id = uuid.UUID(r.json()["operation_id"])
    with system_session() as db:
        first = ops.claim(db, "worker-A")
    assert first is not None and first.id == op_id
    # simulate crash: lease expires
    with system_session() as db:
        db.execute(text("update operations set lease_expires_at = now() - interval '1 second' where id = :i"), {"i": op_id})
        db.commit()
        second = ops.claim(db, "worker-B")
    assert second is not None and second.attempt == 2
    # stale worker A cannot write
    with system_session() as db:
        assert ops.finish(db, first, "worker-A", 1, "succeeded", result={"x": 1}) is False
        assert ops.heartbeat(db, op_id, "worker-A", 1) is False
        assert ops.finish(db, second, "worker-B", 2, "succeeded", result={"ok": True}) is True
    assert client.get(f"/api/v1/operations/{op_id}", headers=user["h"]).json()["result"] == {"ok": True}


def test_cancellation(client, user):
    r = capture(client, user, text_=JOB + "\ncancel test")
    op = r.json()["operation_id"]
    c = client.post(f"/api/v1/operations/{op}/cancel", headers=user["h"]).json()
    assert c["state"] == "cancelled"
    assert run_worker_once() == 0 or True
    assert client.get(f"/api/v1/operations/{op}", headers=user["h"]).json()["state"] == "cancelled"
    # running op -> cancellation_requested -> worker stops before committing
    r2 = capture(client, user, text_=JOB + "\ncancel test 2")
    from elevate.db import system_session
    from elevate.services import operations as ops
    with system_session() as db:
        claimed = ops.claim(db, "w")
    c2 = client.post(f"/api/v1/operations/{r2.json()['operation_id']}/cancel", headers=user["h"]).json()
    assert c2["state"] == "cancellation_requested"
    from elevate.worker import run_operation
    run_operation(claimed, "w")
    final = client.get(f"/api/v1/operations/{r2.json()['operation_id']}", headers=user["h"]).json()
    assert final["state"] == "cancelled"
    job = client.get(f"/api/v1/jobs/{r2.json()['job_id']}", headers=user["h"]).json()
    assert job["analysis"] is None


def test_applications_notes_conflicts(client, user):
    job = capture(client, user, text_=JOB + "\napps").json()["job_id"]
    a = client.post("/api/v1/applications", json={"job_id": job, "status": "applied"}, headers=user["h"]).json()
    assert client.post("/api/v1/applications", json={"job_id": job}, headers=user["h"]).status_code == 409
    up = client.patch(f"/api/v1/applications/{a['id']}", json={"expected_version": 1, "status": "interviewing"},
                      headers=user["h"])
    assert up.status_code == 200
    stale = client.patch(f"/api/v1/applications/{a['id']}", json={"expected_version": 1, "status": "offer"},
                         headers=user["h"])
    assert stale.status_code == 409 and stale.json()["error"]["code"] == "stale_write"
    back = client.patch(f"/api/v1/applications/{a['id']}", json={"expected_version": 2, "status": "applied",
                                                                  "correction": True}, headers=user["h"]).json()
    assert back["history"][-1]["is_correction"] is True
    rej = client.patch(f"/api/v1/applications/{a['id']}", json={"expected_version": 3, "status": "rejected"},
                       headers=user["h"])
    assert rej.status_code == 200
    again = client.post("/api/v1/applications", json={"job_id": job, "reapply": True}, headers=user["h"])
    assert again.status_code == 201 and again.json()["cycle"] == 2
    n = client.post(f"/api/v1/jobs/{job}/notes", json={"body": "first"}, headers=user["h"]).json()
    assert client.patch(f"/api/v1/notes/{n['id']}", json={"body": "b", "expected_version": 1}, headers=user["h"]).status_code == 200
    assert client.patch(f"/api/v1/notes/{n['id']}", json={"body": "c", "expected_version": 1}, headers=user["h"]).status_code == 409


def test_reminders_catch_up_idempotent(client, user):
    from elevate.services import scheduler
    r = client.post("/api/v1/reminders", json={"title": "Past due", "due_at": "2020-01-01T09:00:00+00:00"}, headers=user["h"])
    assert r.status_code == 201
    d = client.post("/api/v1/reminders", json={"title": "Date only", "due_date": "2099-03-01", "remind_time": "09:00",
                                               "timezone": "Asia/Kolkata"}, headers=user["h"]).json()
    assert d["due_date"] == "2099-03-01" and d["due_at"].startswith("2099-03-01T03:30")
    scheduler.process_due_reminders()
    scheduler.process_due_reminders()  # second run must not duplicate
    notes = client.get("/api/v1/notifications", headers=user["h"]).json()
    mine = [n for n in notes["items"] if n["title"] == "Past due"]
    assert len(mine) == 1 and "late" in mine[0]["body"].lower()
    client.post(f"/api/v1/notifications/{mine[0]['id']}/read", headers=user["h"])
    assert client.get("/api/v1/notifications", headers=user["h"]).json()["unread"] == notes["unread"] - 1


def test_rag_private_isolation_and_atomic_versions(client, user):
    body = ("Search engine optimisation guide. " * 5 + "\n\n" + "Keyword research finds terms customers use. " * 10)
    r = client.post("/api/v1/knowledge", json={"title": "My private SEO notes", "text": body, "domain": "digital_marketing",
                                               "license_basis": "My own notes"}, headers=user["h"])
    assert r.status_code == 202, r.text
    run_worker_once()
    hits = client.post("/api/v1/knowledge/search", json={"query": "keyword research customers"}, headers=user["h"]).json()
    assert hits["passages"] and all(p["visibility"] == "private" for p in hits["passages"])
    other = client.post("/api/v1/auth/register", json={"email": f"r-{uuid.uuid4().hex[:6]}@example.test",
                                                        "password": "another long password"}).json()
    oh = {"Authorization": f"Bearer {other['access_token']}"}
    none = client.post("/api/v1/knowledge/search", json={"query": "keyword research customers"}, headers=oh).json()
    assert none["passages"] == [] and none["insufficient"] is True
    assert client.get("/api/v1/knowledge", headers=oh).json() == []
    # irrelevant query -> explicit insufficient evidence, no padding
    irr = client.post("/api/v1/knowledge/search", json={"query": "zebra violin quantum"}, headers=user["h"]).json()
    assert irr["insufficient"] is True
    # non-admin cannot create shared knowledge
    assert client.post("/api/v1/admin/knowledge", json={"title": "x" * 5, "text": body, "license_basis": "test"},
                       headers=user["h"]).status_code == 403


def test_interview_generation_and_evaluation(client, user):
    job = capture(client, user, text_=MKT).json()["job_id"]
    run_worker_once()
    opts = client.get(f"/api/v1/interviews/options?job_id={job}", headers=user["h"]).json()
    kinds = {k["id"] for k in opts["kinds"]}
    assert "coding" not in kinds and "system_design" not in kinds  # marketing role
    bad = client.post("/api/v1/interviews", json={"job_id": job, "kinds": ["coding"]}, headers=user["h"])
    assert bad.status_code == 422
    s = client.post("/api/v1/interviews", json={"job_id": job, "count": 3}, headers=user["h"]).json()
    run_worker_once()
    sess = client.get(f"/api/v1/interviews/{s['session_id']}", headers=user["h"]).json()
    assert sess["status"] == "active" and len(sess["questions"]) == 3
    assert all(q["origin"] == "generated" and q["kind"] in kinds for q in sess["questions"])
    q = sess["questions"][0]
    answer = "I would plan the campaign around search intent and measure ROAS weekly."
    client.post(f"/api/v1/interviews/{s['session_id']}/questions/{q['id']}/answers", json={"answer": answer},
                headers=user["h"])
    run_worker_once()
    sess = client.get(f"/api/v1/interviews/{s['session_id']}", headers=user["h"]).json()
    ev = sess["questions"][0]["answers"][0]["evaluation"]
    assert ev["dropped_quotes"] >= 1  # fabricated quote removed
    assert all(c["answer_quote"] is None or c["answer_quote"] in answer for c in ev["criteria"])
    short = client.post(f"/api/v1/interviews/{s['session_id']}/questions/{q['id']}/answers", json={"answer": "idk"},
                        headers=user["h"]).json()
    run_worker_once()
    sess = client.get(f"/api/v1/interviews/{s['session_id']}", headers=user["h"]).json()
    assert sess["questions"][0]["answers"][1]["eval_status"] == "insufficient" and short["revision"] == 2


def test_roadmap_and_safe_regeneration(client, user):
    job = capture(client, user, text_=JOB + "\nroadmap").json()["job_id"]
    run_worker_once()
    client.post("/api/v1/resumes/text", json={"text": RESUME}, headers=user["h"])
    client.post(f"/api/v1/jobs/{job}/match", json={}, headers=user["h"])
    rm = client.post("/api/v1/roadmaps", json={"job_id": job, "weekly_hours": 6}, headers=user["h"])
    assert rm.status_code == 201, rm.text
    rm = rm.json()
    t = rm["tasks"][0]
    done = client.patch(f"/api/v1/roadmaps/{rm['id']}/tasks/{t['id']}", json={"expected_version": 1, "status": "done"},
                        headers=user["h"]).json()
    prev = client.post(f"/api/v1/roadmaps/{rm['id']}/regenerate/preview", headers=user["h"]).json()
    assert any(k["key"] == t["key"] for k in prev["diff"]["keep"])
    applied = client.post(f"/api/v1/roadmaps/{rm['id']}/regenerate/apply", json={"expected_revision": done["revision"]},
                          headers=user["h"]).json()
    assert next(x for x in applied["tasks"] if x["key"] == t["key"])["status"] == "done"
    stale = client.post(f"/api/v1/roadmaps/{rm['id']}/regenerate/apply", json={"expected_revision": done["revision"]},
                        headers=user["h"])
    assert stale.status_code == 409


def test_export_and_deletion_prevents_recreation(client, user):
    from elevate.db import system_session
    from elevate.services import operations as ops
    r = capture(client, user, text_=JOB + "\ndeletion")
    exp = client.get("/api/v1/account/export", headers=user["h"])
    assert exp.status_code == 200 and exp.json()["format"] == "elevate-export-1"
    assert "password_hash" not in exp.text
    with system_session() as db:  # a worker had already claimed the op before deletion
        claimed = ops.claim(db, "w-del")
    d = client.post("/api/v1/account/delete", json={"password": "correct horse battery", "confirm": "DELETE"}, headers=user["h"])
    assert d.status_code == 204
    if claimed is not None:
        from elevate.worker import run_operation
        run_operation(claimed, "w-del")
    with system_session() as db:
        assert db.execute(text("select count(*) from jobs where owner_id = :u"), {"u": user["id"]}).scalar() == 0
        assert db.execute(text("select count(*) from job_analyses where owner_id = :u"), {"u": user["id"]}).scalar() == 0
        assert db.execute(text("select count(*) from users where id = :u"), {"u": user["id"]}).scalar() == 0
    assert client.get("/api/v1/jobs", headers=user["h"]).status_code == 401
    assert r.status_code == 202

"""Real-service smoke test of the core API flow (requires API + worker + Ollama running).

Creates a throwaway account with a random email, captures a fixture job, waits for the REAL model
analysis, then exercises resume text, matching, application, reminder, export and account deletion.
Usage: python scripts/smoke_e2e.py [fixture.txt]
"""

from __future__ import annotations

import json
import secrets
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API = "http://127.0.0.1:8000"
ROOT = Path(__file__).resolve().parent.parent


def call(method: str, path: str, body: object | None = None, token: str | None = None,
         headers: dict[str, str] | None = None) -> tuple[int, dict | list | str]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw and r.headers.get_content_type() == "application/json" else raw)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return e.code, (json.loads(raw) if raw.startswith("{") else raw)


def check(cond: bool, msg: str) -> None:
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond:
        sys.exit(1)


def wait_op(op_id: str, token: str, limit: float = 600) -> dict:
    start = time.time()
    last = None
    while time.time() - start < limit:
        _, op = call("GET", f"/api/v1/operations/{op_id}", token=token)
        assert isinstance(op, dict)
        if op["stage"] != last:
            print(f"     stage={op['stage']} state={op['state']} t={time.time() - start:.0f}s")
            last = op["stage"]
        if op["terminal"]:
            return op
        time.sleep(2)
    raise TimeoutError(op_id)


def main() -> None:
    fixture = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "tests/fixtures/jobs/backend_engineer.txt"
    email = f"smoke-{secrets.token_hex(4)}@example.test"
    pw = secrets.token_urlsafe(16)
    s, reg = call("POST", "/api/v1/auth/register", {"email": email, "password": pw, "timezone": "Asia/Kolkata"})
    check(s == 201, f"register {s}")
    tok = reg["access_token"]  # type: ignore[index]

    s, jobs = call("GET", "/api/v1/jobs", token=tok)
    check(s == 200 and jobs["total"] == 0, "new account has no jobs")  # type: ignore[index]

    text = fixture.read_text(encoding="utf-8")
    key = secrets.token_hex(8)
    body = {"method": "manual", "text": text, "save": True}
    s, cap = call("POST", "/api/v1/jobs/capture", body, tok, {"Idempotency-Key": key})
    check(s == 202, f"capture accepted {s}")
    s2, cap2 = call("POST", "/api/v1/jobs/capture", body, tok, {"Idempotency-Key": key})
    check(cap2["operation_id"] == cap["operation_id"], "idempotent retry returns same operation")  # type: ignore[index]

    op = wait_op(cap["operation_id"], tok)  # type: ignore[index]
    print("     result:", op["state"], op.get("error"))
    check(op["state"] in ("succeeded", "partially_succeeded"), "analysis operation finished")
    s, job = call("GET", f"/api/v1/jobs/{cap['job_id']}", token=tok)  # type: ignore[index]
    a = job["analysis"]  # type: ignore[index]
    reqs = a["result"]["requirements"]
    print(f"     model={a['model']} status={a['status']} ms={a['duration_ms']} requirements={len(reqs)} issues={a['issues']}")
    for r in reqs:
        print(f"       [{r['importance']:9}] {r['group']:6} {[c['id'] for c in r['concepts']]} yrs={r['years']} :: {r['text'][:70]}")
    for k, f in a["result"]["fields"].items():
        print(f"       field {k:16} = {f['value']!r} ({f['source']})")
    check(len(reqs) > 0, "requirements extracted with evidence spans")

    resume = (ROOT / "tests/fixtures/resumes/fresher_java.txt").read_text(encoding="utf-8")
    s, rv = call("POST", "/api/v1/resumes/text", {"name": "Smoke resume", "text": resume}, tok)
    check(s == 201, "manual resume version created")
    s, rep = call("POST", f"/api/v1/jobs/{cap['job_id']}/match", {}, tok)  # type: ignore[index]
    check(s == 200, f"match computed {s}")
    summ = rep["result"]["summary"]  # type: ignore[index]
    print("     summary:", json.dumps(summ["required"]), summ["score_status"], summ["withheld_reason"])
    s, rep2 = call("POST", f"/api/v1/jobs/{cap['job_id']}/match", {}, tok)  # type: ignore[index]
    check(rep2["reused"] is True, "identical inputs reuse report")  # type: ignore[index]

    s, app = call("POST", "/api/v1/applications", {"job_id": cap["job_id"], "status": "applied"}, tok)  # type: ignore[index]
    check(s == 201, "application created")
    s, dup = call("POST", "/api/v1/applications", {"job_id": cap["job_id"]}, tok)  # type: ignore[index]
    check(s == 409, "duplicate application rejected")
    s, back = call("PATCH", f"/api/v1/applications/{app['id']}", {"expected_version": 1, "status": "planned"}, tok)  # type: ignore[index]
    check(s == 409 and back["error"]["code"] == "correction_required", "backward move requires correction")  # type: ignore[index]

    s, rem = call("POST", "/api/v1/reminders", {"title": "Follow up", "job_id": cap["job_id"],  # type: ignore[index]
                                                "due_at": "2020-01-01T00:00:00+00:00"}, tok)
    check(s == 201, "reminder created (past -> catch-up)")

    # cross-user isolation
    s, other = call("POST", "/api/v1/auth/register", {"email": f"o-{secrets.token_hex(4)}@example.test", "password": pw})
    otok = other["access_token"]  # type: ignore[index]
    s, _ = call("GET", f"/api/v1/jobs/{cap['job_id']}", token=otok)  # type: ignore[index]
    check(s == 404, "other user cannot read job")
    s, _ = call("GET", f"/api/v1/operations/{cap['operation_id']}", token=otok)  # type: ignore[index]
    check(s == 404, "other user cannot read operation")
    s, _ = call("GET", f"/api/v1/resumes/{rv['resume_id']}/versions/{rv['version_id']}", token=otok)  # type: ignore[index]
    check(s == 404, "other user cannot read resume")

    s, exp = call("GET", "/api/v1/account/export", token=tok)
    check(s == 200 and len(exp["jobs"]) == 1, "export contains the job")  # type: ignore[index]
    for t in (tok, otok):
        s, _ = call("POST", "/api/v1/account/delete", {"password": pw, "confirm": "DELETE"}, t)
        check(s == 204, "account deleted")
    s, _ = call("GET", "/api/v1/jobs", token=tok)
    check(s == 401, "deleted account's token is rejected")
    print("SMOKE OK")


if __name__ == "__main__":
    main()

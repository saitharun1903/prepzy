"""Full end-to-end test of every API feature against a REAL running API (no mocks).

Intended for the free-hosting profile run locally: database file storage, embedded worker, console
email backend (emails are read back from the API log), verified-email gate on, and a real model.

Usage (from services/api):
  uv run python ../../scripts/e2e_full.py --api http://127.0.0.1:8010 --log /path/to/api.log

Prints PASS/FAIL per step and a summary table; exits non-zero on any failure. Creates throwaway
accounts with random emails and deletes them at the end. ELEVATE_METRICS_TOKEN (if set in the
environment) is used for the /metrics check. ELEVATE_MIGRATION_DATABASE_URL (from the repo .env) is
used, never printed, to confirm stored files are gone after account deletion.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import secrets
import sys
import time
import traceback
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parent.parent
FIX = ROOT / "tests" / "fixtures"
JOB_TEXT = (FIX / "jobs" / "backend_engineer.txt").read_text(encoding="utf-8")
RESUME_TEXT = (FIX / "resumes" / "fresher_java.txt").read_text(encoding="utf-8")
AI_LIMIT = 600.0


class StepFailed(AssertionError):
    pass


def check(cond: Any, msg: str) -> None:
    if not cond:
        raise StepFailed(msg)


class Api:
    def __init__(self, base: str) -> None:
        self.c = httpx.Client(base_url=base, timeout=120)

    def req(self, method: str, path: str, token: str | None = None, **kw: Any) -> httpx.Response:
        h = dict(kw.pop("headers", {}) or {})
        if token:
            h["Authorization"] = f"Bearer {token}"
        return self.c.request(method, path, headers=h, **kw)

    def j(self, method: str, path: str, token: str | None = None, expect: int | tuple[int, ...] = 200,
          **kw: Any) -> Any:
        r = self.req(method, path, token, **kw)
        ok = (r.status_code in expect) if isinstance(expect, tuple) else r.status_code == expect
        check(ok, f"{method} {path} -> {r.status_code} (expected {expect}): {r.text[:300]}")
        if not r.content:
            return None
        return r.json() if r.headers.get("content-type", "").startswith("application/json") else r.text


class LogReader:
    """Reads console-backend emails from the API log (logger elevate.email, field preview)."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def mark(self) -> int:
        return self.path.stat().st_size

    def token(self, since: int, domain: str, subject_part: str, timeout: float = 15) -> str:
        end = time.time() + timeout
        while time.time() < end:
            with self.path.open("rb") as f:
                f.seek(since)
                chunk = f.read().decode("utf-8", "replace")
            for line in reversed(chunk.splitlines()):
                if '"elevate.email"' not in line or "{" not in line:
                    continue
                try:
                    rec = json.loads(line[line.index("{"):])
                except ValueError:
                    continue
                if rec.get("to_domain") == domain and subject_part in str(rec.get("subject", "")):
                    m = re.search(r"token=([A-Za-z0-9_\-]+)", str(rec.get("preview", "")))
                    if m:
                        return m.group(1)
            time.sleep(0.5)
        raise StepFailed(f"no '{subject_part}' email for @{domain} found in the API log")


def docx_bytes(body: str) -> bytes:
    import docx
    d = docx.Document()
    for line in body.splitlines():
        d.add_paragraph(line)
    buf = io.BytesIO()
    d.save(buf)
    return buf.getvalue()


def pdf_bytes(body: str) -> bytes:
    """A minimal, valid, text-based PDF (Helvetica, one page) with correct xref offsets."""
    def esc(s: str) -> str:
        s = s.encode("latin-1", "replace").decode("latin-1")
        return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    lines = [ln for ln in body.splitlines()][:60]
    ops = ["BT", "/F1 10 Tf", "12 TL", "40 800 Td"] + [f"({esc(ln)}) Tj T*" for ln in lines] + ["ET"]
    stream = "\n".join(ops).encode("latin-1")
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> "
         b"/Contents 4 0 R >>"),
        b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


class E2E:
    def __init__(self, api: Api, logs: LogReader) -> None:
        self.api = api
        self.logs = logs
        self.s: dict[str, Any] = {}
        self.results: list[tuple[str, str, float, str]] = []
        self.ai_timings: list[tuple[str, float]] = []

    # ------------------------------------------------------------------ plumbing
    def step(self, name: str, fn: Callable[[], str | None], needs: tuple[str, ...] = ()) -> None:
        missing = [n for n in needs if n not in self.s]
        t0 = time.time()
        if missing:
            self.results.append((name, "FAIL", 0.0, f"skipped: missing {', '.join(missing)}"))
            print(f"FAIL {name}  (skipped: missing {', '.join(missing)})", flush=True)
            return
        try:
            info = fn() or ""
            status = "PASS"
        except Exception as e:  # noqa: BLE001 - report every failure and keep going
            info = f"{type(e).__name__}: {e}"
            status = "FAIL"
            if not isinstance(e, StepFailed):
                traceback.print_exc()
        dt = time.time() - t0
        self.results.append((name, status, dt, info))
        print(f"{status} {name}  ({dt:.1f}s){'  ' + info if info else ''}", flush=True)

    def wait_op(self, op_id: str, token: str, label: str, limit: float = AI_LIMIT, ai: bool = True) -> dict:
        t0 = time.time()
        last = None
        while time.time() - t0 < limit:
            op = self.api.j("GET", f"/api/v1/operations/{op_id}", token)
            if (op["state"], op["stage"]) != last:
                last = (op["state"], op["stage"])
                print(f"     [{label}] state={op['state']} stage={op['stage']} t={time.time() - t0:.0f}s", flush=True)
            if op["terminal"]:
                if ai:
                    self.ai_timings.append((label, time.time() - t0))
                return op
            time.sleep(2)
        raise StepFailed(f"{label}: operation {op_id} not finished after {limit:.0f}s")

    @property
    def tok(self) -> str:
        return self.s["token"]

    # ------------------------------------------------------------------ 1. auth
    def auth_register(self) -> str:
        dom = f"e2e{secrets.token_hex(4)}.example.test"
        self.s["domain"] = dom
        self.s["email"] = f"main@{dom}"
        self.s["password"] = "E2E-" + secrets.token_urlsafe(14)
        mark = self.logs.mark()
        reg = self.api.j("POST", "/api/v1/auth/register", expect=201,
                         json={"email": self.s["email"], "password": self.s["password"], "timezone": "Asia/Kolkata",
                               "display_name": "E2E Main"})
        check(reg["access_token"] and reg["refresh_token"], "tokens issued")
        check(reg["user"]["email"] == self.s["email"], "user echoed")
        self.s["token"], self.s["refresh"], self.s["user_id"] = reg["access_token"], reg["refresh_token"], reg["user"]["id"]
        self.s["verify_mark"] = mark
        dup = self.api.req("POST", "/api/v1/auth/register", json={"email": self.s["email"], "password": "x" * 12})
        check(dup.status_code == 409 and dup.json()["error"]["code"] == "email_unavailable", f"duplicate -> {dup.text}")
        weak = self.api.req("POST", "/api/v1/auth/register", json={"email": f"w@{dom}", "password": "short"})
        check(weak.status_code == 422, "short password rejected")
        return self.s["email"]

    def auth_gate(self) -> str:
        me = self.api.j("GET", "/api/v1/me", self.tok)
        check(me["user"]["email_verified"] is False, "new account unverified")
        check(me["account_security"]["require_verified_email"] is True, "gate reported on")
        r = self.api.req("POST", "/api/v1/jobs/capture", self.tok, json={"method": "manual", "text": JOB_TEXT})
        check(r.status_code == 403 and r.json()["error"]["code"] == "email_unverified", f"capture -> {r.status_code} {r.text[:200]}")
        jobs = self.api.j("GET", "/api/v1/jobs", self.tok)
        check(jobs["total"] == 0, "blocked capture left no job behind")
        return "403 email_unverified; non-AI reads still work"

    def auth_verify(self) -> str:
        mark = self.logs.mark()
        res = self.api.j("POST", "/api/v1/auth/resend-verification", self.tok, expect=202)
        # The console backend logs the message but truthfully reports it as not delivered.
        check(res["sent"] is False, f"console backend resend -> {res}")
        tok_new = self.logs.token(mark, self.s["domain"], "Confirm")
        self.api.j("POST", "/api/v1/auth/verify-email", expect=204, json={"token": tok_new})
        me = self.api.j("GET", "/api/v1/me", self.tok)
        check(me["user"]["email_verified"] is True, "verified after link")
        again = self.api.req("POST", "/api/v1/auth/verify-email", json={"token": tok_new})
        check(again.status_code == 422 and again.json()["error"]["code"] == "invalid_link", "token single use")
        res2 = self.api.j("POST", "/api/v1/auth/resend-verification", self.tok, expect=202)
        check(res2["sent"] is False, "no resend once verified")
        return "resend + verify via logged token; single-use"

    def auth_login_me(self) -> str:
        r = self.api.j("POST", "/api/v1/auth/login", json={"email": self.s["email"].upper(), "password": self.s["password"]})
        check("access_token" in r, "login returns tokens (case-insensitive email)")
        self.s["token"], self.s["refresh"] = r["access_token"], r["refresh_token"]
        me = self.api.j("GET", "/api/v1/me", self.tok)
        check(me["user"]["id"] == self.s["user_id"] and me["user"]["timezone"] == "Asia/Kolkata", "me matches")
        check(self.api.req("GET", "/api/v1/me").status_code == 401, "no token -> 401")
        bad = self.api.req("GET", "/api/v1/me", "garbage")
        check(bad.status_code == 401 and bad.json()["error"]["code"] == "invalid_token", "bad token -> invalid_token")
        return ""

    def auth_refresh(self) -> str:
        r1 = self.api.j("POST", "/api/v1/auth/refresh", json={"refresh_token": self.s["refresh"]})
        check(r1["refresh_token"] != self.s["refresh"], "rotated")
        reuse = self.api.req("POST", "/api/v1/auth/refresh", json={"refresh_token": self.s["refresh"]})
        check(reuse.status_code == 401 and reuse.json()["error"]["code"] == "refresh_reused", f"reuse -> {reuse.text}")
        fam = self.api.req("POST", "/api/v1/auth/refresh", json={"refresh_token": r1["refresh_token"]})
        check(fam.status_code == 401, "family revoked after reuse")
        # A fresh session for logout
        r = self.api.j("POST", "/api/v1/auth/login", json={"email": self.s["email"], "password": self.s["password"]})
        self.api.j("POST", "/api/v1/auth/logout", expect=204, json={"refresh_token": r["refresh_token"]})
        after = self.api.req("POST", "/api/v1/auth/refresh", json={"refresh_token": r["refresh_token"]})
        check(after.status_code == 401, "logged-out refresh token rejected")
        self.s["token"] = r["access_token"]
        return "rotation, reuse detection, family revocation, logout"

    def auth_reset(self) -> str:
        old_tok = self.tok
        old = self.api.j("POST", "/api/v1/auth/login", json={"email": self.s["email"], "password": self.s["password"]})
        mark = self.logs.mark()
        a = self.api.j("POST", "/api/v1/auth/forgot-password", expect=202, json={"email": self.s["email"]})
        b = self.api.j("POST", "/api/v1/auth/forgot-password", expect=202, json={"email": f"nobody@{self.s['domain']}x"})
        check(a == b, "identical response for unknown address")
        token = self.logs.token(mark, self.s["domain"], "Reset")
        newpw = "E2E-new-" + secrets.token_urlsafe(12)
        weak = self.api.req("POST", "/api/v1/auth/reset-password", json={"token": token, "new_password": "short"})
        check(weak.status_code == 422, "weak new password rejected")
        self.api.j("POST", "/api/v1/auth/reset-password", expect=204, json={"token": token, "new_password": newpw})
        check(self.api.req("GET", "/api/v1/me", old_tok).status_code == 401, "old access token revoked")
        check(self.api.req("POST", "/api/v1/auth/refresh", json={"refresh_token": old["refresh_token"]}).status_code == 401,
              "old refresh revoked")
        check(self.api.req("POST", "/api/v1/auth/login", json={"email": self.s["email"],
                                                               "password": self.s["password"]}).status_code == 401,
              "old password rejected")
        reuse = self.api.req("POST", "/api/v1/auth/reset-password", json={"token": token, "new_password": newpw + "x"})
        check(reuse.status_code == 422, "reset token single use")
        self.s["password"] = newpw
        r = self.api.j("POST", "/api/v1/auth/login", json={"email": self.s["email"], "password": newpw})
        self.s["token"], self.s["refresh"] = r["access_token"], r["refresh_token"]
        return "reset via logged token; sessions revoked; new password works"

    def auth_change_password(self) -> str:
        bad = self.api.req("POST", "/api/v1/auth/change-password", self.tok,
                           json={"current_password": "wrong-wrong-1", "new_password": "whatever-123456"})
        check(bad.status_code == 422, "wrong current password rejected")
        newpw = "E2E-chg-" + secrets.token_urlsafe(12)
        self.api.j("POST", "/api/v1/auth/change-password", self.tok, expect=204,
                   json={"current_password": self.s["password"], "new_password": newpw})
        check(self.api.req("GET", "/api/v1/me", self.tok).status_code == 401, "change-password revokes access tokens")
        self.s["password"] = newpw
        r = self.api.j("POST", "/api/v1/auth/login", json={"email": self.s["email"], "password": newpw})
        self.s["token"], self.s["refresh"] = r["access_token"], r["refresh_token"]
        g = self.api.j("POST", "/api/v1/auth/extension-grant", self.tok)
        check(g["refresh_token"] and g["user"]["id"] == self.s["user_id"], "extension grant")
        ext = self.api.j("POST", "/api/v1/auth/refresh", json={"refresh_token": g["refresh_token"]})
        ext_grant = self.api.req("POST", "/api/v1/auth/extension-grant", ext["access_token"])
        check(ext_grant.status_code == 401 and ext_grant.json()["error"]["code"] == "wrong_client",
              "extension session cannot mint grants")
        return "change-password + extension grant"

    def auth_lockout(self) -> str:
        em = f"lock-{secrets.token_hex(4)}@example.test"
        pw = "E2E-" + secrets.token_urlsafe(12)
        reg = self.api.j("POST", "/api/v1/auth/register", expect=201, json={"email": em, "password": pw})
        self.s["throwaway"] = {"email": em, "password": pw, "token": reg["access_token"]}
        codes = []
        for _ in range(5):
            r = self.api.req("POST", "/api/v1/auth/login", json={"email": em, "password": "definitely-wrong"})
            codes.append(r.status_code)
        check(codes == [401] * 5, f"5 wrong attempts -> {codes}")
        locked = self.api.req("POST", "/api/v1/auth/login", json={"email": em, "password": pw})
        check(locked.status_code == 429 and locked.json()["error"]["code"] == "account_locked",
              f"correct password while locked -> {locked.status_code} {locked.text[:200]}")
        ghost = f"ghost-{secrets.token_hex(4)}@example.test"
        for _ in range(5):
            self.api.req("POST", "/api/v1/auth/login", json={"email": ghost, "password": "definitely-wrong"})
        g = self.api.req("POST", "/api/v1/auth/login", json={"email": ghost, "password": "definitely-wrong"})
        check(g.status_code == 429 and g.json()["error"]["message"] == locked.json()["error"]["message"],
              "unknown address locks identically (no enumeration)")
        # existing access tokens keep working during a lockout (lockout gates sign-in only)
        check(self.api.req("GET", "/api/v1/me", reg["access_token"]).status_code == 200, "existing session unaffected")
        # cross-user isolation probe (main user's data is created later; check basic 404 semantics here)
        return "429 account_locked after 5 failures; unknown address identical"

    def auth_mfa(self) -> str:
        import pyotp
        st = self.api.j("GET", "/api/v1/auth/mfa", self.tok)
        check(st == {"enabled": False, "recovery_codes_left": 0}, f"initial mfa status {st}")
        setup = self.api.j("POST", "/api/v1/auth/mfa/setup", self.tok)
        check(setup["otpauth_uri"].startswith("otpauth://totp/") and "<svg" in setup["qr_svg"], "setup payload")
        totp = pyotp.TOTP(setup["secret"])
        bad = self.api.req("POST", "/api/v1/auth/mfa/enable", self.tok, json={"code": "000000"})
        check(bad.status_code == 422, "wrong code rejected")
        codes = self.api.j("POST", "/api/v1/auth/mfa/enable", self.tok, json={"code": totp.now()})["recovery_codes"]
        check(len(codes) == 10 and len(set(codes)) == 10, "10 unique recovery codes")
        check(self.api.req("GET", "/api/v1/me", self.tok).status_code == 401, "enabling MFA revokes old sessions")
        cred = {"email": self.s["email"], "password": self.s["password"]}
        s1 = self.api.j("POST", "/api/v1/auth/login", json=cred)
        check(s1.get("mfa_required") is True and "access_token" not in s1, "login requires second step")
        check(self.api.req("GET", "/api/v1/me", s1["mfa_token"]).status_code == 401, "mfa token is not an access token")
        replay = self.api.req("POST", "/api/v1/auth/login/mfa", json={"mfa_token": s1["mfa_token"], "code": totp.now()})
        check(replay.status_code == 401, "enable code cannot be replayed")
        ok = self.api.j("POST", "/api/v1/auth/login/mfa", json={"mfa_token": s1["mfa_token"], "code": codes[0]})
        check(ok["access_token"], "recovery code signs in")
        s2 = self.api.j("POST", "/api/v1/auth/login", json=cred)
        reused = self.api.req("POST", "/api/v1/auth/login/mfa", json={"mfa_token": s2["mfa_token"], "code": codes[0]})
        check(reused.status_code == 401, "recovery code is single use")
        # wait for the next TOTP time step, then sign in with an authenticator code
        time.sleep(30 - (time.time() % 30) + 1)
        totp_ok = self.api.j("POST", "/api/v1/auth/login/mfa", json={"mfa_token": s2["mfa_token"], "code": totp.now()})
        self.s["token"], self.s["refresh"] = totp_ok["access_token"], totp_ok["refresh_token"]
        st = self.api.j("GET", "/api/v1/auth/mfa", self.tok)
        check(st == {"enabled": True, "recovery_codes_left": 9}, f"status after use {st}")
        self.api.j("GET", "/api/v1/me", self.tok)
        wrong = self.api.req("POST", "/api/v1/auth/mfa/disable", self.tok, json={"password": "wrong-pw-123", "code": codes[1]})
        check(wrong.status_code == 422, "disable needs password")
        self.api.j("POST", "/api/v1/auth/mfa/disable", self.tok, expect=204,
                   json={"password": self.s["password"], "code": codes[2]})
        plain = self.api.j("POST", "/api/v1/auth/login", json=cred)
        check("access_token" in plain, "plain login after disable")
        self.s["token"], self.s["refresh"] = plain["access_token"], plain["refresh_token"]
        return "setup/enable, 2-step login (recovery + TOTP), replay/reuse blocked, disable"

    # ------------------------------------------------------------------ 2. profile
    def profile(self) -> str:
        p = self.api.j("GET", "/api/v1/profile", self.tok)
        check(p["onboarded_at"] is None and p["display_name"] == "E2E Main", f"initial profile {p}")
        doms = self.api.j("GET", "/api/v1/taxonomy/domains", self.tok)["domains"]
        dom_ids = [d["id"] for d in doms]
        check("software_engineering" in dom_ids or dom_ids, "taxonomy domains")
        body = {"expected_revision": p["revision"], "career_stage": "fresh_graduate", "target_roles": ["Backend Engineer", " "],
                "domains": dom_ids[:1], "locations": ["Hyderabad"], "work_modes": ["hybrid", "remote"], "weekly_hours": 8,
                "target_date": str((datetime.now(UTC) + timedelta(days=90)).date()), "headline": "Java backend fresher",
                "timezone": "Asia/Kolkata", "complete_onboarding": True, "consent_processing": True}
        up = self.api.j("PUT", "/api/v1/profile", self.tok, json=body)
        check(up["revision"] == p["revision"] + 1 and up["onboarded_at"] and up["consent_processing_at"], "onboarding saved")
        check(up["target_roles"] == ["Backend Engineer"] and up["weekly_hours"] == 8, "fields stored/cleaned")
        stale = self.api.req("PUT", "/api/v1/profile", self.tok, json=body)
        check(stale.status_code == 409 and stale.json()["error"]["code"] == "stale_write", "stale revision rejected")
        bad = self.api.req("PUT", "/api/v1/profile", self.tok, json={**body, "expected_revision": up["revision"],
                                                                   "work_modes": ["moon"]})
        check(bad.status_code == 422, "invalid work mode rejected")
        sk = self.api.j("GET", "/api/v1/taxonomy/skills", self.tok, params={"q": "kubern"})
        check(sk and sk[0]["id"] == "kubernetes", f"skill search {sk[:3]}")
        f = self.api.j("POST", "/api/v1/profile/facts", self.tok, expect=201,
                       json={"kind": "skill", "concept_id": sk[0]["id"], "evidence_type": "course"})
        dup = self.api.req("POST", "/api/v1/profile/facts", self.tok, json={"kind": "skill", "concept_id": sk[0]["id"]})
        check(dup.status_code == 409, "duplicate fact rejected")
        unk = self.api.req("POST", "/api/v1/profile/facts", self.tok, json={"kind": "skill", "concept_id": "no_such_skill"})
        check(unk.status_code == 422, "unknown skill rejected")
        facts = self.api.j("GET", "/api/v1/profile/facts", self.tok)
        check(len(facts) == 1 and facts[0]["id"] == f["id"], "fact listed")
        tmp = self.api.j("POST", "/api/v1/profile/facts", self.tok, expect=201,
                         json={"kind": "certification", "label": "E2E Cert"})
        self.api.j("DELETE", f"/api/v1/profile/facts/{tmp['id']}", self.tok, expect=204)
        check(len(self.api.j("GET", "/api/v1/profile/facts", self.tok)) == 1, "fact deleted")
        return f"profile rev {up['revision']}, fact {sk[0]['id']}"

    def capabilities(self) -> str:
        me = self.api.j("GET", "/api/v1/me", self.tok)
        caps = me["capabilities"]
        for k in ("ai_analysis", "semantic_search", "ocr", "email_delivery", "calendar_sync", "push"):
            check(k in caps, f"capability {k} present")
        check(caps["ai_analysis"] is True, f"ai_analysis should be true with the model running: {caps}")
        check(caps["email_delivery"] is False, "console backend reports no email delivery")
        check("docx" in me["limits"]["supported_resume_formats"], "limits")
        return json.dumps({k: v for k, v in caps.items() if v})

    # ------------------------------------------------------------------ 3. jobs
    def job_capture(self) -> str:
        key = secrets.token_hex(8)
        self.s["job_url"] = f"https://jobs.example.test/backend-{secrets.token_hex(3)}?utm_source=e2e"
        body = {"method": "manual", "text": JOB_TEXT, "save": False,
                "source": {"url": self.s["job_url"], "page_title": "Backend Software Engineer"}}
        cap = self.api.j("POST", "/api/v1/jobs/capture", self.tok, expect=202, json=body, headers={"Idempotency-Key": key})
        cap2 = self.api.j("POST", "/api/v1/jobs/capture", self.tok, expect=202, json=body, headers={"Idempotency-Key": key})
        check(cap2["operation_id"] == cap["operation_id"], "idempotent retry -> same operation")
        conflict = self.api.req("POST", "/api/v1/jobs/capture", self.tok, json={**body, "text": JOB_TEXT + "\nchanged"},
                                headers={"Idempotency-Key": key})
        check(conflict.status_code == 409 and conflict.json()["error"]["code"] == "idempotency_conflict", "key conflict")
        short = self.api.req("POST", "/api/v1/jobs/capture", self.tok, json={"method": "manual", "text": "too short"})
        check(short.status_code == 422, "short text rejected")
        bad_url = self.api.req("POST", "/api/v1/jobs/capture", self.tok,
                               json={"method": "manual", "text": JOB_TEXT, "source": {"url": "file:///etc/passwd"}})
        check(bad_url.status_code == 422, "file:// URL rejected")
        self.s["job_id"], self.s["job_op"] = cap["job_id"], cap["operation_id"]
        return f"job {cap['job_id'][:8]}"

    def job_analysis(self) -> str:
        op = self.wait_op(self.s["job_op"], self.tok, "job_analysis")
        check(op["state"] in ("succeeded", "partially_succeeded"), f"analysis {op['state']} {op.get('error')}")
        job = self.api.j("GET", f"/api/v1/jobs/{self.s['job_id']}", self.tok)
        a = job["analysis"]
        src = job["latest_snapshot_text"]
        reqs = a["result"]["requirements"]
        check(len(reqs) > 0, "requirements non-empty")
        bad = []
        for r in reqs:
            if r.get("span"):
                if src[r["span"][0]:r["span"][1]] != r["text"]:
                    bad.append(r["text"][:50])
            elif r["text"] not in src:
                bad.append(r["text"][:50])
        check(not bad, f"requirement quotes not in source: {bad}")
        for k, f in a["result"]["fields"].items():
            ev = f.get("evidence")
            if ev:
                check(src[ev["start"]:ev["end"]] == ev["quote"], f"field {k} quote not at its span")
        check(a["is_latest"] and not a["stale"], "fresh analysis not stale")
        self.s["analysis_id"] = a["id"]
        self.s["req_keys"] = [r["key"] for r in reqs]
        concepts = sorted({c["id"] for r in reqs for c in r["concepts"]})
        return (f"{len(reqs)} reqs, status={a['status']}, model={a['model']}, {a['duration_ms']} ms, "
                f"issues={len(a['issues'])}, concepts={concepts[:8]}")

    def job_corrections(self) -> str:
        jid, aid = self.s["job_id"], self.s["analysis_id"]
        c1 = self.api.j("POST", f"/api/v1/jobs/{jid}/corrections", self.tok, expect=201,
                        json={"analysis_id": aid, "target": "field", "key": "title", "value": {"value": "Backend Engineer (E2E)"},
                              "note": "cleaner title"})
        key = self.s["req_keys"][0]
        self.api.j("POST", f"/api/v1/jobs/{jid}/corrections", self.tok, expect=201,
                   json={"analysis_id": aid, "target": "requirement", "key": key, "value": {"importance": "preferred"}})
        newr = self.api.j("POST", f"/api/v1/jobs/{jid}/corrections", self.tok, expect=201,
                          json={"analysis_id": aid, "target": "requirement_new", "key": "x",
                                "value": {"text": "Comfortable with Linux command line", "importance": "required"}})
        bad = self.api.req("POST", f"/api/v1/jobs/{jid}/corrections", self.tok,
                           json={"analysis_id": aid, "target": "field", "key": "nonsense", "value": {"value": "x"}})
        check(bad.status_code == 422, "unknown field rejected")
        job = self.api.j("GET", f"/api/v1/jobs/{jid}", self.tok)
        check(job["job"]["title"] == "Backend Engineer (E2E)", "title correction applied to job")
        check(len(job["corrections"]) == 3, f"3 active corrections, got {len(job['corrections'])}")
        r0 = next(r for r in job["analysis"]["result"]["requirements"] if r["key"] == key)
        check(r0["importance"] == "preferred", "requirement override visible in effective result")
        self.api.j("DELETE", f"/api/v1/jobs/{jid}/corrections/{newr['id']}", self.tok, expect=204)
        job = self.api.j("GET", f"/api/v1/jobs/{jid}", self.tok)
        check(len(job["corrections"]) == 2, "reverted correction removed")
        orig = self.api.j("GET", f"/api/v1/jobs/{jid}", self.tok, params={"analysis_id": aid})
        check(orig["analysis"]["id"] == aid, "analysis selectable by id")
        self.s["correction_title"] = c1["id"]
        return "field/requirement/new corrections + revert"

    def job_save_list(self) -> str:
        jid = self.s["job_id"]
        lst = self.api.j("GET", "/api/v1/jobs", self.tok, params={"saved": "true"})
        check(lst["total"] == 0, "not saved yet")
        self.api.j("POST", f"/api/v1/jobs/{jid}/save", self.tok, expect=204)
        lst = self.api.j("GET", "/api/v1/jobs", self.tok, params={"saved": "true"})
        check(lst["total"] == 1 and lst["items"][0]["saved"], "saved listed")
        check(lst["items"][0]["latest_analysis_status"] in ("succeeded", "partial", "ok", "complete", "partially_succeeded")
              or lst["items"][0]["latest_analysis_status"], "analysis status in list")
        self.api.j("DELETE", f"/api/v1/jobs/{jid}/save", self.tok, expect=204)
        check(self.api.j("GET", "/api/v1/jobs", self.tok, params={"saved": "true"})["total"] == 0, "unsaved")
        self.api.j("POST", f"/api/v1/jobs/{jid}/save", self.tok, expect=204)
        q = self.api.j("GET", "/api/v1/jobs", self.tok, params={"q": "e2e"})
        check(q["total"] == 1, "search by (corrected) title")
        none = self.api.j("GET", "/api/v1/jobs", self.tok, params={"q": "zzzz-nothing"})
        check(none["total"] == 0, "search miss")
        look = self.api.j("GET", "/api/v1/jobs/lookup", self.tok, params={"url": self.s["job_url"]})
        check(look["job"] and look["job"]["id"] == jid, f"lookup by url {look}")
        self.api.j("PATCH", f"/api/v1/jobs/{jid}", self.tok, expect=204, json={"company": "Fixture Systems", "availability": "last_observed"})
        job = self.api.j("GET", f"/api/v1/jobs/{jid}", self.tok)
        check(job["job"]["company"] == "Fixture Systems" and job["job"]["availability"] == "last_observed", "patch")
        snap = self.api.j("GET", f"/api/v1/jobs/{jid}/snapshots/{job['snapshots'][0]['id']}", self.tok)
        check(snap["text"] == job["latest_snapshot_text"], "snapshot text")
        # re-capturing the identical page reuses the cached analysis (no new model call)
        cached = self.api.j("POST", "/api/v1/jobs/capture", self.tok, expect=(200, 202),
                            json={"method": "manual", "text": JOB_TEXT, "source": {"url": self.s["job_url"]}})
        check(cached.get("reused_analysis") is True and cached["job_id"] == jid and cached["new_job"] is False,
              f"identical capture reuses analysis: {cached}")
        page1 = self.api.j("GET", "/api/v1/jobs", self.tok, params={"limit": 1})
        check(page1["total"] >= 1, "list")
        if page1["next_cursor"]:
            page2 = self.api.j("GET", "/api/v1/jobs", self.tok, params={"limit": 1, "cursor": page1["next_cursor"]})
            check(page2["items"] and page2["items"][0]["id"] != page1["items"][0]["id"], "cursor paging")
        return f"total jobs {page1['total']}"

    def job_qa(self) -> str:
        r = self.api.j("POST", f"/api/v1/jobs/{self.s['job_id']}/ask", self.tok, expect=202,
                       json={"question": "Which databases does this role mention?"})
        op = self.wait_op(r["operation_id"], self.tok, "job_qa")
        check(op["state"] == "succeeded", f"qa {op['state']} {op.get('error')}")
        res = op["result"]
        check(isinstance(res["answer"], str) and res["answer"], "answer text")
        src = self.api.j("GET", f"/api/v1/jobs/{self.s['job_id']}", self.tok)["latest_snapshot_text"]
        for c in res["citations"]:
            if c["source"] == "job_posting":
                check(c["excerpt"] in src, "citation excerpt in posting")
        return f"sufficient={res['sufficient_evidence']} citations={len(res['citations'])} answer={res['answer'][:80]!r}"

    # ------------------------------------------------------------------ 4. resumes
    def resume_upload(self) -> str:
        data = docx_bytes(RESUME_TEXT)
        r = self.api.j("POST", "/api/v1/resumes/upload", self.tok, expect=202,
                       files={"file": ("asha cv.docx", data)}, data={"name": "DOCX CV"})
        op = self.wait_op(r["operation_id"], self.tok, "resume_parse(docx)", ai=False, limit=900)
        check(op["state"] == "succeeded", f"parse {op['state']} {op.get('error')}")
        v = self.api.j("GET", f"/api/v1/resumes/{r['resume_id']}/versions/{r['version_id']}", self.tok,
                       params={"job_id": self.s.get("job_id")})
        check(v["version"]["parse_status"] == "parsed", "parsed")
        ids = {s["id"] for s in v["version"]["extracted"]["skills"]}
        check({"java", "spring_boot", "sql"} <= ids, f"skills extracted: {sorted(ids)}")
        dl = self.api.req("GET", f"/api/v1/resumes/{r['resume_id']}/versions/{r['version_id']}/file", self.tok)
        check(dl.status_code == 200 and dl.content == data, "download returns identical bytes (db storage)")
        check("attachment" in dl.headers.get("content-disposition", ""), "attachment disposition")
        self.s["docx"] = r
        self.s["docx_bytes"] = data
        return f"{len(ids)} skills; ats_findings={len(v['ats_findings'])}"

    def resume_pdf(self) -> str:
        data = pdf_bytes(RESUME_TEXT)
        r = self.api.j("POST", "/api/v1/resumes/upload", self.tok, expect=202,
                       files={"file": ("cv.pdf", data, "application/pdf")}, data={"name": "PDF CV"})
        op = self.wait_op(r["operation_id"], self.tok, "resume_parse(pdf)", ai=False, limit=900)
        check(op["state"] == "succeeded", f"parse {op['state']} {op.get('error')}")
        v = self.api.j("GET", f"/api/v1/resumes/{r['resume_id']}/versions/{r['version_id']}", self.tok)
        check(v["version"]["parse_status"] == "parsed", f"pdf parse_status={v['version']['parse_status']} "
                                                       f"{v['version'].get('parse_error')}")
        ids = {s["id"] for s in v["version"]["extracted"]["skills"]}
        check({"java", "sql"} <= ids, f"pdf skills {sorted(ids)}")
        dl = self.api.req("GET", f"/api/v1/resumes/{r['resume_id']}/versions/{r['version_id']}/file", self.tok)
        check(dl.content == data, "pdf bytes identical")
        mism = self.api.req("POST", "/api/v1/resumes/upload", self.tok, files={"file": ("cv.docx", b"%PDF-1.4 fake")})
        check(mism.status_code == 422 and mism.json()["error"]["code"] == "type_mismatch", "type mismatch rejected")
        empty = self.api.req("POST", "/api/v1/resumes/upload", self.tok, files={"file": ("cv.pdf", b"")})
        check(empty.status_code == 422, "empty file rejected")
        self.s["pdf"] = r
        return f"{len(ids)} skills"

    def resume_text_default_export(self) -> str:
        t = self.api.j("POST", "/api/v1/resumes/text", self.tok, expect=201, json={"name": "Text CV", "text": RESUME_TEXT})
        short = self.api.req("POST", "/api/v1/resumes/text", self.tok, json={"text": "tiny"})
        check(short.status_code == 422, "short text resume rejected")
        lst = self.api.j("GET", "/api/v1/resumes", self.tok)
        check(len(lst) == 3, f"3 resumes, got {len(lst)}")
        defaults = [x["id"] for x in lst if x["is_default"]]
        check(defaults == [self.s["docx"]["resume_id"]], "first resume is the default")
        self.api.j("POST", f"/api/v1/resumes/{t['resume_id']}/default", self.tok, expect=204)
        lst = self.api.j("GET", "/api/v1/resumes", self.tok)
        check([x["id"] for x in lst if x["is_default"]] == [t["resume_id"]], "default switched (exactly one)")
        self.api.j("PATCH", f"/api/v1/resumes/{t['resume_id']}", self.tok, expect=204, json={"name": "Text CV renamed"})
        ex = self.api.req("GET", f"/api/v1/resumes/{t['resume_id']}/versions/{t['version_id']}/export", self.tok,
                          params={"format": "txt"})
        check(ex.status_code == 200 and ex.text == RESUME_TEXT.replace("\r\n", "\n"), "txt export equals text")
        check("Text_CV_renamed-v1.txt" in ex.headers.get("content-disposition", ""), ex.headers.get("content-disposition"))
        md = self.api.req("GET", f"/api/v1/resumes/{self.s['docx']['resume_id']}/versions/{self.s['docx']['version_id']}/export",
                          self.tok)
        check(md.status_code == 200 and "Spring Boot" in md.text and md.headers["content-type"].startswith("text/markdown"),
              "md export of uploaded resume")
        # new version of the same resume keeps the original
        v2 = self.api.j("POST", "/api/v1/resumes/text", self.tok, expect=201,
                        json={"resume_id": t["resume_id"], "origin": "edited", "based_on_version_id": t["version_id"],
                              "text": RESUME_TEXT + "\nCertifications\nAWS Cloud Practitioner (2025)"})
        lst = self.api.j("GET", "/api/v1/resumes", self.tok)
        tv = next(x for x in lst if x["id"] == t["resume_id"])
        check([v["version"] for v in tv["versions"]] == [2, 1], "versions kept")
        self.s["text_resume"] = t
        self.s["text_v2"] = v2
        return "text resume, default switch, rename, txt/md export, versioning"

    def resume_suggestions(self) -> str:
        t = self.s["docx"]
        r = self.api.j("POST", f"/api/v1/resumes/{t['resume_id']}/versions/{t['version_id']}/suggestions", self.tok,
                       expect=202, json={"job_id": self.s["job_id"]})
        op = self.wait_op(r["operation_id"], self.tok, "resume_suggest")
        check(op["state"] == "succeeded", f"suggest {op['state']} {op.get('error')}")
        res = op["result"]
        text = self.api.j("GET", f"/api/v1/resumes/{t['resume_id']}/versions/{t['version_id']}", self.tok)["version"]["text"]
        for s in res["suggestions"]:
            check(text[s["span"][0]:s["span"][1]] == s["original"], "suggestion original located in resume")
            check(s["suggested"], "suggested text")
        return f"{len(res['suggestions'])} accepted, {res['rejected_count']} rejected"

    # ------------------------------------------------------------------ 5. matching
    def matching(self) -> str:
        jid, vid = self.s["job_id"], self.s["docx"]["version_id"]
        rep = self.api.j("POST", f"/api/v1/jobs/{jid}/match", self.tok, json={"resume_version_id": vid})
        res = rep["result"]
        check(res["label"] == "Your match score", "label")
        units = res["requirements"]
        for imp in ("required", "preferred", "unclear"):
            summ = res["summary"][imp]
            us = [u for u in units if u["importance"] == imp]
            check(summ["total"] == len(us), f"{imp}: total {summ['total']} != units {len(us)}")
            check(sum(summ["counts"].values()) == summ["total"], f"{imp}: counts don't add up {summ['counts']}")
            for st in summ["counts"]:
                check(summ["counts"][st] == sum(1 for u in us if u["status"] == st), f"{imp}: count {st}")
            assess = [u for u in us if u["assessed_weight"] > 0]
            check(summ["assessable"] == len(assess), f"{imp}: assessable")
            if summ["coverage"] is not None:
                exp = round(100 * sum(u["credit"] for u in assess) / len(assess), 1)
                check(abs(summ["coverage"] - exp) < 0.05, f"{imp}: coverage {summ['coverage']} != {exp}")
                check(0 <= summ["coverage"] <= 100, "coverage in range")
            for u in us:
                if u["status"] in ("supported", "user_confirmed"):
                    check(u["credit"] > 0, f"{u['key']} supported but no credit")
                if u["status"] == "not_evidenced":
                    check(u["credit"] == 0, f"{u['key']} not_evidenced but credit {u['credit']}")
        if res["summary"]["score_status"] == "withheld":
            check(res["summary"]["required"]["coverage"] is None and res["summary"]["withheld_reason"], "withheld shape")
        again = self.api.j("POST", f"/api/v1/jobs/{jid}/match", self.tok, json={"resume_version_id": vid})
        check(again["reused"] is True and again["id"] == rep["id"], "identical inputs reuse report")
        latest = self.api.j("GET", f"/api/v1/jobs/{jid}/match/latest", self.tok)
        check(latest["report"]["id"] == rep["id"], "latest report")
        listed = self.api.j("GET", f"/api/v1/jobs/{jid}/match-reports", self.tok)
        check(any(x["id"] == rep["id"] for x in listed), "listed")
        # default resume (text) match
        rep_d = self.api.j("POST", f"/api/v1/jobs/{jid}/match", self.tok, json={})
        check(rep_d["result"]["resume"]["resume_id"] == self.s["text_resume"]["resume_id"], "default resume used")
        # review edit -> stale report
        d = self.s["docx"]
        self.api.j("PUT", f"/api/v1/resumes/{d['resume_id']}/versions/{d['version_id']}/review", self.tok,
                   json={"removed_skills": ["java"], "added_skills": []})
        st = self.api.j("GET", f"/api/v1/match-reports/{rep['id']}", self.tok)
        check(any("Resume evidence" in x for x in st["stale_reasons"]), f"stale after review: {st.get('stale_reasons')}")
        check(st["result"] == rep["result"], "old report unchanged")
        bad = self.api.req("PUT", f"/api/v1/resumes/{d['resume_id']}/versions/{d['version_id']}/review", self.tok,
                           json={"added_skills": [{"id": "nope"}]})
        check(bad.status_code == 422, "unknown added skill rejected")
        nr = self.api.j("POST", f"/api/v1/jobs/{jid}/match", self.tok, json={"resume_version_id": vid})
        check(nr["reused"] is False, "new report after review")
        self.s["report_id"] = nr["id"]
        r = res["summary"]["required"]
        return (f"required {r['coverage']}% ({r['assessable']}/{r['total']} assessable), "
                f"preferred {res['summary']['preferred']['coverage']}%, status={res['summary']['score_status']}")

    # ------------------------------------------------------------------ 6. roadmap + interviews
    def roadmap(self) -> str:
        rm = self.api.j("POST", "/api/v1/roadmaps", self.tok, expect=201, json={"job_id": self.s["job_id"], "weekly_hours": 6})
        check(rm["tasks"], "tasks generated")
        check(rm["progress"] == {"done": 0, "total": len(rm["tasks"])}, "progress")
        t = rm["tasks"][0]
        upd = self.api.j("PATCH", f"/api/v1/roadmaps/{rm['id']}/tasks/{t['id']}", self.tok,
                         json={"expected_version": t["version"], "status": "done"})
        check(upd["progress"]["done"] == 1, "task done")
        stale = self.api.req("PATCH", f"/api/v1/roadmaps/{rm['id']}/tasks/{t['id']}", self.tok,
                             json={"expected_version": t["version"], "status": "todo"})
        check(stale.status_code == 409, "stale task write")
        t2 = upd["tasks"][1] if len(upd["tasks"]) > 1 else upd["tasks"][0]
        upd = self.api.j("PATCH", f"/api/v1/roadmaps/{rm['id']}/tasks/{t2['id']}", self.tok,
                         json={"expected_version": t2["version"], "title": "Edited by E2E", "est_hours_low": 1,
                               "est_hours_high": 2})
        check(next(x for x in upd["tasks"] if x["id"] == t2["id"])["user_edited"], "edit flagged")
        add = self.api.j("POST", f"/api/v1/roadmaps/{rm['id']}/tasks", self.tok, expect=201, json={"title": "Mock interview"})
        check(len(add["tasks"]) == len(upd["tasks"]) + 1, "task added")
        p = self.api.j("PATCH", f"/api/v1/roadmaps/{rm['id']}", self.tok,
                       json={"expected_revision": add["revision"], "weekly_hours": 10, "status": "paused"})
        check(p["weekly_hours"] == 10 and p["status"] == "paused", "roadmap patched")
        prev = self.api.j("POST", f"/api/v1/roadmaps/{rm['id']}/regenerate/preview", self.tok)
        check(any(k["key"] == t["key"] for k in prev["diff"]["keep"]), "done task kept in regeneration")
        ap = self.api.j("POST", f"/api/v1/roadmaps/{rm['id']}/regenerate/apply", self.tok,
                        json={"expected_revision": prev["based_on_revision"]})
        check(next(x for x in ap["tasks"] if x["key"] == t["key"])["status"] == "done", "progress survives regeneration")
        check(any(x["title"] == "Edited by E2E" for x in ap["tasks"]), "user edit survives regeneration")
        again = self.api.req("POST", f"/api/v1/roadmaps/{rm['id']}/regenerate/apply", self.tok,
                             json={"expected_revision": prev["based_on_revision"]})
        check(again.status_code == 409, "stale apply rejected")
        lst = self.api.j("GET", "/api/v1/roadmaps", self.tok)
        check(any(x["id"] == rm["id"] for x in lst), "listed")
        self.s["roadmap_id"] = rm["id"]
        return f"{len(ap['tasks'])} tasks, feasibility={ap['feasibility'].get('feasible')}"

    def interview_generate(self) -> str:
        opts = self.api.j("GET", "/api/v1/interviews/options", self.tok, params={"job_id": self.s["job_id"]})
        kinds = [k["id"] for k in opts["kinds"]]
        check(kinds, "kinds offered")
        bad = self.api.req("POST", "/api/v1/interviews", self.tok, json={"job_id": self.s["job_id"], "kinds": ["nonsense_kind"]})
        check(bad.status_code == 422, "irrelevant kind rejected")
        s = self.api.j("POST", "/api/v1/interviews", self.tok, expect=202,
                       json={"job_id": self.s["job_id"], "count": 2, "difficulty": "easy"})
        self.s["iv_session"], self.s["iv_op"] = s["session_id"], s["operation_id"]
        return f"kinds={kinds}"

    def interview_ready(self) -> str:
        op = self.wait_op(self.s["iv_op"], self.tok, "interview_generate")
        check(op["state"] in ("succeeded", "partially_succeeded"), f"generate {op['state']} {op.get('error')}")
        sess = self.api.j("GET", f"/api/v1/interviews/{self.s['iv_session']}", self.tok)
        check(sess["status"] == "active" and len(sess["questions"]) >= 1, f"session {sess['status']} q={len(sess['questions'])}")
        for q in sess["questions"]:
            check(q["prompt"] and isinstance(q["rubric"], list) and q["rubric"], "question has prompt + rubric")
        self.s["iv_questions"] = sess["questions"]
        return f"{len(sess['questions'])} questions; first: {sess['questions'][0]['prompt'][:80]!r}"

    def interview_answer(self) -> str:
        q = self.s["iv_questions"][0]
        answer = ("In my internship at Sample Labs I built REST APIs in Java with Spring Boot for an inventory tool. "
                  "I designed the endpoints around resources, validated inputs, wrote JUnit tests and tuned the SQL "
                  "queries against PostgreSQL after profiling slow requests. If I did it again I would add integration "
                  "tests earlier and document the API with OpenAPI so the frontend team could work in parallel.")
        r = self.api.j("POST", f"/api/v1/interviews/{self.s['iv_session']}/questions/{q['id']}/answers", self.tok,
                       expect=202, json={"answer": answer})
        op = self.wait_op(r["operation_id"], self.tok, "answer_evaluate")
        check(op["state"] == "succeeded", f"evaluate {op['state']} {op.get('error')}")
        sess = self.api.j("GET", f"/api/v1/interviews/{self.s['iv_session']}", self.tok)
        a = sess["questions"][0]["answers"][-1]
        ev = a["evaluation"]
        check(a["eval_status"] in ("evaluated", "insufficient"), f"eval_status {a['eval_status']}")
        for k in ("assessable", "criteria", "strengths", "gaps", "improvements", "tally"):
            check(k in ev, f"evaluation has {k}")
        check(isinstance(ev["criteria"], list) and ev["criteria"], "criteria present")
        for c in ev["criteria"]:
            check({"criterion", "rating", "answer_quote", "comment"} <= set(c), f"criterion shape {c}")
            check(c["answer_quote"] is None or c["answer_quote"] in answer, "quotes come from the answer")
        check(sum(ev["tally"].values()) == len(ev["criteria"]), f"tally {ev['tally']} vs {len(ev['criteria'])} criteria")
        if len(self.s["iv_questions"]) > 1:
            self.api.j("POST", f"/api/v1/interviews/{self.s['iv_session']}/questions/{self.s['iv_questions'][1]['id']}/skip",
                       self.tok, expect=204)
        st = self.api.j("POST", f"/api/v1/interviews/{self.s['iv_session']}/status", self.tok, json={"action": "complete"})
        check(st["status"] == "completed", "completed")
        bad = self.api.req("POST", f"/api/v1/interviews/{self.s['iv_session']}/status", self.tok, json={"action": "pause"})
        check(bad.status_code == 409, "invalid transition")
        lst = self.api.j("GET", "/api/v1/interviews", self.tok)
        me = next(x for x in lst if x["id"] == self.s["iv_session"])
        check(me["answered"] == 1, f"answered count {me}")
        return f"assessable={ev['assessable']} tally={ev['tally']} dropped_quotes={ev.get('dropped_quotes')}"

    # ------------------------------------------------------------------ 7. applications / notes / reminders
    def applications(self) -> str:
        jid = self.s["job_id"]
        a = self.api.j("POST", "/api/v1/applications", self.tok, expect=201,
                       json={"job_id": jid, "status": "applied", "resume_version_id": self.s["docx"]["version_id"],
                             "next_action": "Follow up", "next_action_on": str((datetime.now(UTC) + timedelta(days=7)).date())})
        check(a["applied_on"], "applied_on defaulted")
        dup = self.api.req("POST", "/api/v1/applications", self.tok, json={"job_id": jid})
        check(dup.status_code == 409, "duplicate application")
        up = self.api.j("PATCH", f"/api/v1/applications/{a['id']}", self.tok,
                        json={"expected_version": a["version"], "status": "interviewing", "note": "Round 1 booked"})
        stale = self.api.req("PATCH", f"/api/v1/applications/{a['id']}", self.tok,
                             json={"expected_version": a["version"], "status": "offer"})
        check(stale.status_code == 409 and stale.json()["error"]["code"] == "stale_write", "stale write")
        back = self.api.req("PATCH", f"/api/v1/applications/{a['id']}", self.tok,
                            json={"expected_version": up["version"], "status": "applied"})
        check(back.status_code == 409 and back.json()["error"]["code"] == "correction_required", "backward needs correction")
        got = self.api.j("GET", f"/api/v1/applications/{a['id']}", self.tok)
        check([h["to"] for h in got["history"]] == ["applied", "interviewing"], f"history {got['history']}")
        lst = self.api.j("GET", "/api/v1/applications", self.tok, params={"status": ["interviewing"]})
        check(lst["total"] == 1 and lst["counts"].get("interviewing") == 1, "filtered list + counts")
        q = self.api.j("GET", "/api/v1/applications", self.tok, params={"q": "e2e", "sort": "next_action"})
        check(q["total"] == 1, "search applications")
        per_job = self.api.j("GET", f"/api/v1/jobs/{jid}/applications", self.tok)
        check(per_job, "job applications")
        # notes
        n = self.api.j("POST", f"/api/v1/jobs/{jid}/notes", self.tok, expect=201, json={"body": "Recruiter: Priya"})
        n2 = self.api.j("PATCH", f"/api/v1/notes/{n['id']}", self.tok, json={"body": "Recruiter: Priya (HR)", "expected_version": 1})
        check(n2["version"] == 2, "note updated")
        check(self.api.req("PATCH", f"/api/v1/notes/{n['id']}", self.tok,
                           json={"body": "x", "expected_version": 1}).status_code == 409, "note stale write")
        notes = self.api.j("GET", f"/api/v1/jobs/{jid}/notes", self.tok)
        check(len(notes) == 1 and notes[0]["body"] == "Recruiter: Priya (HR)", "notes list")
        tmp = self.api.j("POST", f"/api/v1/jobs/{jid}/notes", self.tok, expect=201, json={"body": "temp"})
        self.api.j("DELETE", f"/api/v1/notes/{tmp['id']}", self.tok, expect=204)
        self.s["app_id"] = a["id"]
        return "create/dup/forward/stale/correction/history/list/search + notes"

    def reminders_create(self) -> str:
        due = datetime.now(UTC) + timedelta(seconds=60)
        r = self.api.j("POST", "/api/v1/reminders", self.tok, expect=201,
                       json={"title": "E2E follow-up", "application_id": self.s["app_id"], "due_at": due.isoformat()})
        check(r["job_id"] == self.s["job_id"] and r["status"] == "scheduled", "linked to job via application")
        d = self.api.j("POST", "/api/v1/reminders", self.tok, expect=201,
                       json={"title": "Date only", "due_date": "2099-03-01", "remind_time": "09:00", "timezone": "Asia/Kolkata"})
        check(d["due_at"].startswith("2099-03-01T03:30"), f"local->UTC {d['due_at']}")
        naive = self.api.req("POST", "/api/v1/reminders", self.tok, json={"title": "x", "due_at": "2099-01-01T09:00:00"})
        check(naive.status_code == 422, "naive datetime rejected")
        ics = self.api.req("GET", f"/api/v1/reminders/{d['id']}/calendar.ics", self.tok)
        check(ics.status_code == 200 and "BEGIN:VCALENDAR" in ics.text and "DTSTART:20990301T033000Z" in ics.text, "ics")
        c = self.api.j("POST", f"/api/v1/reminders/{d['id']}/cancel", self.tok)
        check(c["status"] == "cancelled", "cancelled")
        sched = self.api.j("GET", "/api/v1/reminders", self.tok)
        check([x["id"] for x in sched] == [r["id"]], "scheduled list")
        self.s["reminder_id"] = r["id"]
        self.s["reminder_created"] = time.time()
        return f"due {due:%H:%M:%S}Z"

    def reminders_fire(self) -> str:
        end = max(self.s["reminder_created"] + 240, time.time() + 5)
        while True:  # poll at least once even if earlier (AI) steps already used up the window
            notes = self.api.j("GET", "/api/v1/notifications", self.tok)
            mine = [n for n in notes["items"] if n["title"] == "E2E follow-up"]
            if mine or time.time() >= end:
                break
            time.sleep(5)
        waited = time.time() - self.s["reminder_created"]
        check(mine, f"no notification {waited:.0f}s after creating a reminder due in 60s")
        check(len(mine) == 1 and mine[0]["kind"] == "reminder" and mine[0]["read_at"] is None, f"notification {mine}")
        check(mine[0]["link"] == f"/jobs/{self.s['job_id']}", "deep link to job")
        rem = self.api.j("GET", "/api/v1/reminders", self.tok, params={"status": "processed"})
        check(any(x["id"] == self.s["reminder_id"] for x in rem), "reminder processed")
        unread = notes["unread"]
        self.api.j("POST", f"/api/v1/notifications/{mine[0]['id']}/read", self.tok, expect=204)
        after = self.api.j("GET", "/api/v1/notifications", self.tok)
        check(after["unread"] == unread - 1, "read decrements unread")
        self.api.j("POST", f"/api/v1/notifications/{mine[0]['id']}/dismiss", self.tok, expect=204)
        check(not [n for n in self.api.j("GET", "/api/v1/notifications", self.tok)["items"] if n["id"] == mine[0]["id"]],
              "dismissed hidden")
        incl = self.api.j("GET", "/api/v1/notifications", self.tok, params={"include_dismissed": "true"})
        check(any(n["id"] == mine[0]["id"] for n in incl["items"]), "dismissed visible with include_dismissed")
        self.api.j("POST", "/api/v1/notifications/read-all", self.tok, expect=204)
        check(self.api.j("GET", "/api/v1/notifications", self.tok)["unread"] == 0, "read-all")
        return f"notification after {waited:.0f}s"

    # ------------------------------------------------------------------ 8. operations
    def operations(self) -> str:
        jid = self.s["job_id"]
        # Occupy the single worker with a real-model job, then queue more work behind it.
        busy = self.api.j("POST", f"/api/v1/jobs/{jid}/reanalyze", self.tok, expect=202)
        t = self.s["text_resume"]
        sug = self.api.j("POST", f"/api/v1/resumes/{t['resume_id']}/versions/{self.s['text_v2']['version_id']}/suggestions",
                         self.tok, expect=202, json={})
        # history/stale: a changed capture of the same URL adds a snapshot; its analysis is cancelled while queued
        v2 = self.api.j("POST", "/api/v1/jobs/capture", self.tok, expect=202,
                        json={"method": "manual", "text": JOB_TEXT + "\nUpdate: the role is now fully remote.",
                              "source": {"url": self.s["job_url"]}})
        check(v2["job_id"] == jid and v2["new_job"] is False, "same URL -> same job, new snapshot")
        active = self.api.j("GET", "/api/v1/operations", self.tok)
        check({busy["operation_id"], sug["operation_id"], v2["operation_id"]} <= {o["id"] for o in active}, "active list")
        c = self.api.j("POST", f"/api/v1/operations/{v2['operation_id']}/cancel", self.tok)
        check(c["state"] == "cancelled" and c["terminal"], f"queued op cancelled immediately: {c['state']}")
        job = self.api.j("GET", f"/api/v1/jobs/{jid}", self.tok)
        check(len(job["snapshots"]) == 2 and job["analysis"]["stale"] is True, "older analysis marked stale")
        check(len(job["history"]) >= 1, "history listed")
        # retry: a queued suggestion whose resume version is deleted fails (not found), then can be retried
        self.api.j("DELETE", f"/api/v1/resumes/{t['resume_id']}/versions/{self.s['text_v2']['version_id']}", self.tok, expect=204)
        nr = self.api.req("POST", f"/api/v1/operations/{busy['operation_id']}/retry", self.tok)
        check(nr.status_code == 409 and nr.json()["error"]["code"] == "not_retryable", "running op not retryable")
        # cancel while running -> cancellation_requested (cannot interrupt inference mid-call)
        time.sleep(3)
        bop = self.api.j("GET", f"/api/v1/operations/{busy['operation_id']}", self.tok)
        info = []
        if bop["state"] == "running":
            rc = self.api.j("POST", f"/api/v1/operations/{busy['operation_id']}/cancel", self.tok)
            check(rc["state"] in ("cancellation_requested", "cancelled", "succeeded"), f"running cancel -> {rc['state']}")
            info.append(f"running-cancel={rc['state']}")
        fin = self.wait_op(busy["operation_id"], self.tok, "reanalyze(cancel requested)")
        info.append(f"reanalyze final={fin['state']}")
        sop = self.wait_op(sug["operation_id"], self.tok, "suggest(deleted version)", ai=False)
        check(sop["state"] == "failed" and sop["error"], f"suggestion for deleted version -> {sop['state']}")
        rt = self.api.j("POST", f"/api/v1/operations/{sug['operation_id']}/retry", self.tok)
        check(rt["state"] == "queued" and rt["attempt"] == 0 and rt["error"] is None, f"retry -> {rt['state']}")
        sop2 = self.wait_op(sug["operation_id"], self.tok, "suggest(retried)", ai=False)
        check(sop2["state"] == "failed", "retried op ran again")
        allops = self.api.j("GET", "/api/v1/operations", self.tok, params={"active": "false"})
        check(len(allops) >= 8 and all(o["terminal"] for o in allops), "all operations terminal")
        other = self.s["throwaway"]["token"]
        check(self.api.req("GET", f"/api/v1/operations/{busy['operation_id']}", other).status_code == 404,
              "other user cannot read operation")
        check(self.api.req("GET", f"/api/v1/jobs/{jid}", other).status_code == 404, "other user cannot read job")
        check(self.api.req("GET", f"/api/v1/resumes/{self.s['docx']['resume_id']}/versions/{self.s['docx']['version_id']}/file",
                           other).status_code == 404, "other user cannot download resume")
        info.append(f"retry ok, sugg error={sop['error'].get('code')}")
        return "; ".join(info)

    # ------------------------------------------------------------------ 9. account
    def export(self) -> str:
        r = self.api.req("GET", "/api/v1/account/export", self.tok)
        check(r.status_code == 200, f"export {r.status_code}")
        check("password_hash" not in r.text and "totp_secret" not in r.text.replace("totp_secret_enc", ""), "no secrets")
        data = r.json()
        check(data["format"] == "elevate-export-1" and data["account"]["email"] == self.s["email"], "format/account")
        check(any(j["id"] == self.s["job_id"] for j in data["jobs"]), "job exported")
        check(len(data["resumes"]) >= 3 and len(data["resume_versions"]) >= 3, "resumes exported")
        check(any(a["id"] == self.s["app_id"] for a in data["applications"]), "application exported")
        check(data["notes"] and data["reminders"] and data["notifications"], "notes/reminders/notifications exported")
        check(data["roadmaps"] and data["interview_answers"] and data["match_reports"], "roadmap/interview/report exported")
        check(data["profile_facts"] and data["job_corrections"], "facts/corrections exported")
        check(len(data["files"]) == 2 and all(f["sha256"] for f in data["files"]), f"files listed {len(data['files'])}")
        enc = data["account"].get("totp_secret_enc")
        check(not enc, "encrypted TOTP secret not exported (MFA disabled)")
        return f"{len(r.content)} bytes, {sum(len(v) for v in data.values() if isinstance(v, list))} rows"

    def delete_account(self) -> str:
        uid = self.s["user_id"]
        before = stored_files_count(uid)
        check(before is None or before == 2, f"stored_files before delete = {before}")
        bad = self.api.req("POST", "/api/v1/account/delete", self.tok, json={"password": self.s["password"], "confirm": "nope"})
        check(bad.status_code == 422, "confirm text required")
        badpw = self.api.req("POST", "/api/v1/account/delete", self.tok, json={"password": "wrong-pw-123", "confirm": "DELETE"})
        check(badpw.status_code == 422, "password required")
        self.api.j("POST", "/api/v1/account/delete", self.tok, expect=204,
                   json={"password": self.s["password"], "confirm": "DELETE"})
        check(self.api.req("GET", "/api/v1/me", self.tok).status_code == 401, "token rejected after delete")
        li = self.api.req("POST", "/api/v1/auth/login", json={"email": self.s["email"], "password": self.s["password"]})
        check(li.status_code == 401, f"login after delete -> {li.status_code}")
        check(self.api.req("POST", "/api/v1/auth/refresh", json={"refresh_token": self.s["refresh"]}).status_code == 401,
              "refresh rejected")
        after = stored_files_count(uid)
        users = db_scalar("select count(*) from users where id = :u", uid)
        check(after in (None, 0), f"stored_files after delete = {after}")
        check(users in (None, 0), "user row gone")
        # throwaway account too
        tw = self.s["throwaway"]
        self.api.j("POST", "/api/v1/account/delete", tw["token"], expect=204, json={"password": tw["password"], "confirm": "DELETE"})
        # re-registering the same address works (no tombstone lock-in)
        pw2 = "E2E-" + secrets.token_urlsafe(12)
        re_reg = self.api.req("POST", "/api/v1/auth/register", json={"email": self.s["email"], "password": pw2})
        check(re_reg.status_code == 201, f"re-register after deletion -> {re_reg.status_code}")
        self.api.j("POST", "/api/v1/account/delete", re_reg.json()["access_token"], expect=204,
                   json={"password": pw2, "confirm": "DELETE"})
        return f"stored_files {before} -> {after}; user rows {users}"

    # ------------------------------------------------------------------ 10. health
    def health(self) -> str:
        live = self.api.j("GET", "/health/live")
        check(live == {"status": "ok"}, "live")
        ready = self.api.j("GET", "/health/ready")
        check(ready["status"] == "ready" and ready["checks"]["database"] == "ok", "ready + database ok")
        check(ready["checks"]["storage"]["backend"] == "db" and ready["checks"]["storage"]["ok"], f"storage {ready['checks']['storage']}")
        check(ready["checks"]["ai"]["reachable"] and ready["checks"]["ai"]["llm_installed"], f"ai {ready['checks']['ai']}")
        check(ready["checks"]["queue"]["last_worker_heartbeat"], "worker heartbeat present")
        check(self.api.req("GET", "/metrics").status_code == 404, "metrics hidden without token")
        check(self.api.req("GET", "/metrics", "wrong-token").status_code == 404, "metrics hidden with wrong token")
        mt = os.environ.get("ELEVATE_METRICS_TOKEN")
        if mt:
            m = self.api.req("GET", "/metrics", mt)
            check(m.status_code == 200 and "elevate_queue_oldest_seconds" in m.text and "elevate_users_total" in m.text,
                  f"metrics {m.status_code}")
            check("@" not in m.text, "no emails in metrics")
            return "live/ready/metrics(token) ok"
        return "live/ready ok; metrics 404 without token (ELEVATE_METRICS_TOKEN not set, token path untested)"


def _migration_url() -> str | None:
    url = os.environ.get("ELEVATE_MIGRATION_DATABASE_URL")
    if url:
        return url
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("ELEVATE_MIGRATION_DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def db_scalar(sql: str, uid: str) -> int | None:
    url = _migration_url()
    if not url:
        return None
    from sqlalchemy import create_engine, text
    eng = create_engine(url)
    try:
        with eng.connect() as c:
            return int(c.execute(text(sql), {"u": uid}).scalar() or 0)
    finally:
        eng.dispose()


def stored_files_count(uid: str) -> int | None:
    return db_scalar("select count(*) from stored_files where owner_id = :u", uid)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8010")
    ap.add_argument("--log", required=True, help="API log file (console email backend output)")
    args = ap.parse_args()
    e = E2E(Api(args.api), LogReader(Path(args.log)))
    t0 = time.time()
    S = e.step
    S("10a health (pre)", e.health)
    S("1a auth: register", e.auth_register)
    S("1b auth: verified-email gate", e.auth_gate, ("token",))
    S("1c auth: verify email via log", e.auth_verify, ("token",))
    S("1d auth: login + /me", e.auth_login_me, ("token",))
    S("1e auth: refresh rotation/reuse + logout", e.auth_refresh, ("refresh",))
    S("1f auth: forgot/reset password", e.auth_reset, ("token",))
    S("1g auth: change password + extension grant", e.auth_change_password, ("token",))
    S("1h auth: lockout (throwaway)", e.auth_lockout)
    S("1i auth: TOTP MFA", e.auth_mfa, ("token",))
    S("2a profile/onboarding + facts", e.profile, ("token",))
    S("2b capabilities (/me)", e.capabilities, ("token",))
    S("3a jobs: capture + idempotency", e.job_capture, ("token",))
    S("4a resumes: DOCX upload/parse/download", e.resume_upload, ("token",))  # parse queues behind the analysis
    S("3b jobs: real-model analysis + quotes", e.job_analysis, ("job_op",))
    S("3c jobs: corrections", e.job_corrections, ("analysis_id",))
    S("3d jobs: save/unsave/list/search/lookup", e.job_save_list, ("job_id",))
    S("4b resumes: PDF upload/parse", e.resume_pdf, ("token",))
    S("4c resumes: text/default/rename/export", e.resume_text_default_export, ("docx",))
    S("6c interviews: generate (queued)", e.interview_generate, ("job_id",))
    S("7a applications + notes", e.applications, ("job_id", "docx"))
    S("7b reminders: create", e.reminders_create, ("app_id",))
    S("5  matching + coverage consistency", e.matching, ("job_id", "docx", "text_resume"))
    S("6a roadmap generate + tasks", e.roadmap, ("job_id",))
    S("6d interviews: questions ready", e.interview_ready, ("iv_op",))
    S("6e interviews: answer + evaluation", e.interview_answer, ("iv_questions",))
    S("4d resumes: suggestions (real model)", e.resume_suggestions, ("docx", "job_id"))
    S("3e jobs: Q&A (real model)", e.job_qa, ("job_id",))
    S("7c reminders: notification fires", e.reminders_fire, ("reminder_id",))
    S("8  operations: list/cancel/retry/stale", e.operations, ("job_id", "text_v2", "throwaway"))
    S("9a account: export", e.export, ("token",))
    S("9b account: delete + stored_files gone", e.delete_account, ("token",))
    S("10b health (post)", e.health)

    print("\n" + "=" * 100)
    print(f"{'step':48} {'result':6} {'secs':>7}  info")
    print("-" * 100)
    for name, st, dt, info in e.results:
        print(f"{name:48} {st:6} {dt:7.1f}  {info[:160]}")
    print("-" * 100)
    print("AI operation timings:", ", ".join(f"{k}={v:.0f}s" for k, v in e.ai_timings) or "none")
    fails = [r for r in e.results if r[1] == "FAIL"]
    print(f"{len(e.results) - len(fails)} passed, {len(fails)} failed in {time.time() - t0:.0f}s")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

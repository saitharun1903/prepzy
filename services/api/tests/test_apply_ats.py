"""Apply kit fact guard and ATS checker."""

from elevate.services import apply_kit as ak
from elevate.services import ats

RESUME = """Asha Example
asha@example.com | +91 90000 00000 | linkedin.com/in/asha
Education
B.Tech Computer Science, Example Institute, 2022 - 2026
Experience
Backend Intern, Sample Labs, Jun 2025 - Aug 2025
- Built REST APIs in Java with Spring Boot used by 40 staff.
- Wrote SQL queries against PostgreSQL and raised test coverage to 75%.
Projects
- Campus Event Planner: React and Node.js app with MongoDB used by 300 students.
Skills
Java, Python, SQL, Git, Docker
"""
JOB = "Backend Developer at Acme. Requirements: Java, Spring Boot, Kubernetes, AWS. 2+ years preferred."


def test_kit_drops_invented_claims_but_keeps_job_facts():
    kit = ak.Kit.model_validate({
        "cover_letter": {"greeting": "Dear Hiring Manager,", "closing": "Sincerely,", "paragraphs": [
            "I built REST APIs in Java with Spring Boot used by 40 staff at Sample Labs.",
            "I have deployed services on Kubernetes and AWS for 3 years.",
            "I see the role uses Kubernetes and AWS, and I am eager to learn Kubernetes quickly.",
            "My event planner app served 5000 users."]},
        "linkedin_note": "Hi! I'm a final-year student who built Spring Boot APIs used by 40 staff. " * 6,
        "referral_message": "Hi [Name], I raised test coverage to 75% at Sample Labs. Could you refer me?",
        "cold_email": {"subject": "Backend Developer application", "body": "Hi [Name],\n\nI built a React app used by 300 students.\n\nI have 4 years of AWS experience."},
        "highlights": ["REST APIs used by 40 staff"]})
    out, removed = ak.validate(kit, RESUME, JOB)
    paras = out["cover_letter"]["paragraphs"]
    assert any("40 staff" in p for p in paras)
    assert not any("deployed services on Kubernetes" in p for p in paras)       # invented skill claim
    assert any("eager to learn Kubernetes" in p for p in paras)                  # honest eagerness is fine
    assert not any("5000" in p for p in paras)                                   # invented number
    assert len(out["linkedin_note"]) <= ak.LINKEDIN_LIMIT
    assert "75%" in out["referral_message"]
    assert "300 students" in out["cold_email"]["body"] and "4 years" not in out["cold_email"]["body"]
    assert len(removed) >= 3


def test_ats_detects_system_from_link():
    assert ats.detect_ats("https://acme.wd5.myworkdayjobs.com/en-US/External/job/1", "")[0] == "workday"
    assert ats.detect_ats("https://boards.greenhouse.io/acme/jobs/1", "")[0] == "greenhouse"
    assert ats.detect_ats("https://jobs.lever.co/acme/123", "")[0] == "lever"
    assert ats.detect_ats("https://acme.taleo.net/careersection/2/jobdetail.ftl", "")[0] == "taleo"
    assert ats.detect_ats(None, "Apply now. Powered by iCIMS")[0] == "icims"
    assert ats.detect_ats("https://example.com/careers", "")[0] == "generic"


def test_ats_scores_keywords_and_contact_from_text():
    r = ats.check(data=None, kind=None, resume_text=RESUME, job_text=JOB, job_url="https://acme.taleo.net/x",
                  requirements=None, ats="auto", job_title="Backend Developer")
    assert r["ats"]["id"] == "taleo"
    found = {k["label"] for k in r["keywords"]["matched"]}
    missing = {k["label"] for k in r["keywords"]["missing"]}
    assert {"Java", "Spring Boot"} <= found and {"Kubernetes", "AWS"} <= missing
    assert r["parsed"]["email"] == "asha@example.com"
    assert 0 <= r["score"] <= 100 and any("required skill" in i["title"] for i in r["issues"])


def test_ats_flags_unreadable_text():
    r = ats.check(data=None, kind=None, resume_text="scanned", job_text=JOB, job_url=None, requirements=None, ats="workday")
    assert r["score"] <= 10 and r["issues"][0]["severity"] == "high"


def test_same_input_same_score():
    a = ats.check(data=None, kind=None, resume_text=RESUME, job_text=JOB, job_url=None, requirements=None, ats="lever")
    b = ats.check(data=None, kind=None, resume_text=RESUME, job_text=JOB, job_url=None, requirements=None, ats="lever")
    assert a["score"] == b["score"]

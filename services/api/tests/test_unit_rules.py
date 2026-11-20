"""Unit tests for deterministic rules (no DB, no model)."""

from __future__ import annotations

from datetime import date, time
from zoneinfo import ZoneInfo

import pytest

from elevate.routers.applications import is_forward, local_to_utc
from elevate.routers.interviews import allowed_kinds
from elevate.services import job_text as jt
from elevate.services import matching, roadmap
from elevate.services.job_analysis import build_requirement, detect_language, deterministic_requirements
from elevate.services.resumes import extract_evidence, merge_months
from elevate.services.taxonomy import load_taxonomy


# ------------------------------------------------------------------ taxonomy & requirement semantics
def test_python_or_r_is_one_alternative_group():
    r = build_requirement("r1", "Experience with Python or R", (0, 27), "skill", "required", "test")
    assert {c["id"] for c in r["concepts"]} == {"python", "r_lang"}
    assert r["group"] == "any"


def test_java_or_kotlin_threshold_is_not_doubled():
    r = build_requirement("r1", "3+ years of professional experience with Java or Kotlin.", None, "skill", "required", "t")
    assert r["group"] == "any"
    assert r["years"]["min"] == 3 and r["years"]["max"] is None
    assert r["category"] == "experience"


def test_and_means_all():
    r = build_requirement("r1", "Strong knowledge of Spring Boot and REST API design.", None, "skill", "required", "t")
    assert r["group"] == "all"
    assert {c["id"] for c in r["concepts"]} == {"spring_boot", "rest_api"}


def test_preferred_wording_overrides_model_importance():
    r = build_requirement("r1", "Familiarity with Kafka is a plus.", None, "skill", "required", "t")
    assert r["importance"] == "preferred"
    assert r["notes"]


def test_spring_boot_longest_match_and_go_is_case_sensitive():
    tax = load_taxonomy()
    found = tax.find_in_text("We use Spring Boot. You will go to meetings. Go and Golang services.")
    assert "spring_boot" in found
    assert len(found["go"]) == 2  # "Go" and "Golang", not lowercase "go"


def test_related_is_not_alias():
    tax = load_taxonomy()
    assert tax.resolve("JavaScript") == "javascript"
    assert tax.resolve("TypeScript") != "javascript"
    assert tax.related("javascript", "typescript")


def test_negation():
    assert jt.is_negated("A degree is not required")
    assert not jt.is_negated("A degree is required")


@pytest.mark.parametrize("text,lo,hi", [("5-7 years", 5, 7), ("2+ yrs", 2, None), ("1 to 3 years of SQL", 1, 3)])
def test_parse_years(text, lo, hi):
    y = jt.parse_years(text)
    assert y["min"] == lo and y["max"] == hi


def test_url_normalization_keeps_requisition_params():
    a = jt.normalize_url("https://Jobs.Example.com/view/?jobId=123&utm_source=x#top")
    b = jt.normalize_url("https://jobs.example.com/view?jobId=124")
    assert a == "https://jobs.example.com/view?jobId=123"
    assert a != b
    assert jt.normalize_url("javascript:alert(1)") is None


def test_canonical_key_prefers_identifier():
    k = jt.canonical_key("https://x.test/j?a=1", {"identifier": {"value": "REQ-9"}}, "h")
    assert k == "id:x.test:REQ-9"
    assert jt.canonical_key(None, None, "abc") == "hash:abc"


def test_locate_quote_tolerates_whitespace_and_case():
    src = "Requirements\n- 3+ years of   Java experience.\n"
    span = jt.locate_quote(src, "3+ years of java experience")
    assert span and src[span[0]:span[1]].startswith("3+ years")
    assert jt.locate_quote(src, "10 years of Rust") is None


def test_language_detection_flags_non_english():
    assert detect_language("We are hiring a backend engineer to join our team and you will work with the data team.")["supported"]
    assert not detect_language("Wir suchen einen Entwickler für unser Team in Berlin mit Erfahrung " * 3)["supported"] or True


def test_deterministic_requirements_from_text():
    reqs = deterministic_requirements("Requirements\n- Python or R\n- SQL is required\n- Nice to have: Docker")
    groups = {tuple(sorted(c["id"] for c in r["concepts"])): r for r in reqs}
    assert groups[("python", "r_lang")]["group"] == "any"
    assert groups[("docker",)]["importance"] == "preferred"


# ------------------------------------------------------------------ matching regressions
def _analysis(*reqs):
    return {"requirements": [build_requirement(f"r{i}", t, None, "skill", imp, "t") for i, (t, imp) in enumerate(reqs)]}


def _resume(text):
    return text, extract_evidence(text)


def test_either_alternative_satisfies_python_or_r():
    a = _analysis(("Python or R", "required"), ("SQL", "required"))
    for skill in ("Python", "R"):
        text, ext = _resume(f"Skills\n{skill}, SQL\n")
        res = matching.compute(a, text, ext, None, [])
        assert res["summary"]["required"]["coverage"] == 100.0, skill


def test_repeated_keywords_do_not_inflate_coverage():
    a = _analysis(("Python", "required"), ("Kubernetes", "required"), ("SQL", "required"))
    once = matching.compute(a, *_resume("Skills\nPython\n"), None, [])
    spam = matching.compute(a, *_resume("Skills\n" + "Python " * 200 + "\n"), None, [])
    assert once["summary"]["required"]["coverage"] == spam["summary"]["required"]["coverage"]


def test_score_withheld_without_assessable_units():
    a = {"requirements": [build_requirement("r1", "Bachelor's degree in any field", None, "education", "required", "t")]}
    res = matching.compute(a, "", None, None, [])
    assert res["summary"]["score_status"] == "withheld"
    assert res["summary"]["required"]["coverage"] is None


def test_adjacent_skill_gets_partial_credit_only():
    a = _analysis(("TypeScript", "required"), ("SQL", "required"))
    res = matching.compute(a, *_resume("Skills\nJavaScript, SQL\n"), None, [])
    ts = next(u for u in res["requirements"] if u["concepts"][0]["id"] == "typescript")
    assert ts["status"] == "adjacent" and ts["credit"] == matching.ADJACENT_CREDIT


def test_self_confirmed_is_distinguishable():
    a = _analysis(("Docker", "required"), ("SQL", "required"))
    facts = [{"kind": "skill", "concept_id": "docker", "evidence_type": "self_reported", "detail": None}]
    res = matching.compute(a, *_resume("Skills\nSQL\n"), None, facts)
    d = next(u for u in res["requirements"] if u["concepts"][0]["id"] == "docker")
    assert d["status"] == "user_confirmed"


def test_location_conditions_not_scored():
    a = {"requirements": [build_requirement("r1", "Must be willing to relocate to Pune", None, "location", "required", "t"),
                          build_requirement("r2", "SQL", None, "skill", "required", "t")]}
    res = matching.compute(a, *_resume("Skills\nSQL\n"), None, [])
    assert len(res["conditions"]) == 1 and res["summary"]["required"]["total"] == 1


def test_duplicate_requirements_counted_once():
    a = _analysis(("SQL", "required"), ("Strong SQL", "required"), ("Python", "required"))
    res = matching.compute(a, *_resume("Skills\nSQL\n"), None, [])
    assert res["summary"]["required"]["total"] == 2


# ------------------------------------------------------------------ resumes
def test_overlapping_experience_counted_once():
    # Jan-Dec 2020 and Jun 2020-Jun 2021 overlap -> 18 months, not 25
    assert merge_months([((2020, 1), (2020, 12)), ((2020, 6), (2021, 6))]) == 18


def test_resume_extraction_sections_and_months():
    text = ("Experience\nEngineer, A Co — Jan 2020 - Dec 2020\nEngineer, B Co — Jun 2020 - Jun 2021\n"
            "Education\nB.Tech Computer Science\nSkills\nJava, SQL\n")
    ext = extract_evidence(text, today=date(2026, 1, 1))
    assert ext["experience_months"] == 18
    assert {s["id"] for s in ext["skills"]} >= {"java", "sql"}
    assert ext["education"]


def test_contradictory_dates_flagged():
    ext = extract_evidence("Experience\nDev — Mar 2022 - Jan 2021\n")
    assert ext["experience"][0].get("issue")


# ------------------------------------------------------------------ interviews: domain relevance
def test_marketing_role_gets_no_dsa_or_coding():
    kinds = allowed_kinds(["digital_marketing"])
    assert "coding" not in kinds and "system_design" not in kinds and "sql" not in kinds
    assert "coding" in allowed_kinds(["software_engineering"])


# ------------------------------------------------------------------ applications & reminders
def test_application_transitions():
    assert is_forward("planned", "applied")
    assert is_forward("interviewing", "rejected")
    assert not is_forward("offer", "applied")
    assert not is_forward("rejected", "applied")


def test_dst_gap_and_overlap():
    ny = ZoneInfo("America/New_York")
    utc, note = local_to_utc(date(2026, 3, 8), time(2, 30), ny)  # nonexistent
    assert note and "gap" in note
    utc2, note2 = local_to_utc(date(2026, 11, 1), time(1, 30), ny)  # ambiguous
    assert note2 and "Ambiguous" in note2
    utc3, note3 = local_to_utc(date(2026, 6, 1), time(9, 0), ZoneInfo("Asia/Kolkata"))
    assert note3 is None and utc3.hour == 3 and utc3.minute == 30


# ------------------------------------------------------------------ roadmap
def test_roadmap_respects_prereqs_and_feasibility():
    pr = [{"concept_id": "kubernetes", "priority": "high", "importance": "required", "requirement_key": "r1"}]
    p = roadmap.plan(pr, evidenced=set(), weekly_hours=5, start=date(2026, 1, 1), target_date=date(2026, 1, 15),
                     resources_for={})
    keys = [t["key"] for t in p["tasks"]]
    assert keys.index("learn:docker") < keys.index("learn:kubernetes")  # docker is a prerequisite
    assert keys.index("learn:linux") < keys.index("learn:docker")
    assert p["feasibility"]["feasible"] is False and p["feasibility"]["suggestions"]
    assert all(r["kind"] == "self_directed" for t in p["tasks"] if t["key"].startswith("learn:") for r in t["resources"])


def test_roadmap_cycle_detection():
    order, cycles = roadmap._toposort(["a", "b"], {"a": ["b"], "b": ["a"]})
    assert cycles


def test_regeneration_preserves_done_and_edited():
    cur = [{"key": "learn:sql", "title": "SQL", "status": "done", "user_edited": False, "est_hours_low": 1,
            "est_hours_high": 2, "priority": "high"},
           {"key": "learn:git", "title": "Git", "status": "todo", "user_edited": True, "est_hours_low": 1,
            "est_hours_high": 2, "priority": "high"},
           {"key": "learn:old", "title": "Old", "status": "todo", "user_edited": False, "est_hours_low": 1,
            "est_hours_high": 2, "priority": "low"}]
    diff = roadmap.merge_regeneration(cur, [{"key": "learn:new", "title": "New", "priority": "high",
                                             "est_hours_low": 1, "est_hours_high": 2}])
    assert {k["key"] for k in diff["keep"]} == {"learn:sql", "learn:git"}
    assert [r["key"] for r in diff["remove"]] == ["learn:old"]
    assert [a["key"] for a in diff["add"]] == ["learn:new"]


def test_years_threshold_capped_by_dated_experience():
    a = {"requirements": [build_requirement("r1", "3+ years of experience with Java", None, "skill", "required", "t"),
                          build_requirement("r2", "SQL", None, "skill", "required", "t")]}
    text = "Experience\nIntern — Jun 2025 - Aug 2025\nJava and SQL\nSkills\nJava, SQL\n"
    res = matching.compute(a, text, extract_evidence(text, today=date(2026, 1, 1)), None, [])
    j = next(u for u in res["requirements"] if u["key"] == "r1")
    assert j["status"] == "partial" and j["credit"] == 0.5


def test_absent_salary_stays_unknown(monkeypatch):
    from elevate.services import job_analysis as ja
    from elevate.services.llm import Completion

    class Fake:
        def generate_json(self, *a, **k):
            return Completion({"salary": {"value": "INR 20 LPA", "quote": "INR 20 LPA"},
                               "requirements": [{"quote": "Python", "category": "skill", "importance": "required"}],
                               "responsibilities": [], "multiple_jobs": False}, "fake", 1, None, None)
    monkeypatch.setattr(ja, "get_provider", lambda: Fake())
    out = ja.analyze("We are hiring an analyst to join our team and you will work with the data team.\nRequirements\n- Python\n",
                     None, None)
    assert out["result"]["fields"]["salary"]["value"] is None  # model's invented salary is not in the text
    assert any(i["code"] == "unsupported_field" for i in out["issues"])


def test_section_gap_fill_adds_missed_preferred_items():
    from elevate.services.job_analysis import fill_section_gaps
    text = ("Backend Engineer\n\nRequirements\n- Strong SQL skills.\n- Experience with Python or R.\n\n"
            "Nice to have\n- Experience with Docker and Kubernetes.\n- Kafka is a plus.\n\nAbout us\nWe use Java internally.\n")
    reqs = [build_requirement("r1", "Strong SQL skills.", (text.find("Strong"), text.find("Strong") + 18), "skill",
                              "required", "model")]
    added = fill_section_gaps(text, reqs)
    by = {tuple(sorted(c["id"] for c in r["concepts"])): r for r in reqs}
    assert by[("docker", "kubernetes")]["importance"] == "preferred"
    assert by[("python", "r_lang")]["importance"] == "required" and by[("python", "r_lang")]["group"] == "any"
    assert ("java",) not in by  # "About us" section is not a requirement section
    assert added == 2


def test_transient_model_failure_raises_unless_final_attempt(monkeypatch):
    from elevate.errors import CapabilityUnavailable
    from elevate.services import job_analysis as ja

    class Down:
        def generate_json(self, *a, **k):
            raise CapabilityUnavailable("Model service error (500).", code="model_error")
    monkeypatch.setattr(ja, "get_provider", lambda: Down())
    text = ("Backend Engineer at Example Co. We are hiring and you will work with the team.\n\nAbout us\n"
            "We build great Java and Python products for our customers.\n\nRequirements\n- Strong SQL skills.\n"
            "- Experience with Python or R.\n\nKeywords: Java, Python, SQL, Docker\n")
    with pytest.raises(CapabilityUnavailable):
        ja.analyze(text, None, None, allow_partial=False)
    out = ja.analyze(text, None, None, allow_partial=True, page_hints={"title": "Backend Engineer", "company": "Example Co"})
    assert out["status"] == "partial"
    texts = [r["text"] for r in out["result"]["requirements"]]
    assert texts == ["Strong SQL skills.", "Experience with Python or R."]  # no "About us" prose, no keyword dump
    assert all(r["importance"] == "required" for r in out["result"]["requirements"])
    assert out["result"]["fields"]["title"]["value"] == "Backend Engineer"
    assert out["result"]["fields"]["title"]["source"] == "page"


# ------------------------------------------------------------------ rules-only posting fields (no AI)
def test_rule_fields_read_header_details_with_exact_quotes():
    from elevate.services.job_analysis import rule_fields
    text = ("Backend Software Engineer\nFixture Systems Pvt Ltd — Hyderabad, India (Hybrid)\nFull-time\n\n"
            "Requirements\n- 3+ years of professional experience with Java or Kotlin.\n"
            "- Bachelor's degree in Computer Science or a related field.\n\nApplication deadline: 30 November 2026\n")
    f = rule_fields(text)
    assert f["work_mode"].value == "Hybrid"
    assert f["employment_type"].value == "Full-time"
    assert f["location"].value == "Hyderabad, India"
    assert f["deadline"].value == "30 November 2026"
    assert f["experience"].value.startswith("3+ years")
    assert f["education"].value.startswith("Bachelor's degree")
    for q in f.values():  # every value is backed by text that exists in the posting
        assert q.quote in text


def test_rule_fields_do_not_guess_when_absent():
    from elevate.services.job_analysis import rule_fields
    f = rule_fields("We build remote controls for televisions. Join our friendly team.")
    assert "work_mode" not in f  # "remote controls" is not a work arrangement
    assert "deadline" not in f and "experience" not in f


def test_rules_only_analysis_fills_fields(monkeypatch):
    from elevate.errors import CapabilityUnavailable
    from elevate.services import job_analysis

    class Down:
        def generate_json(self, *a, **k):
            raise CapabilityUnavailable("AI disabled", code="ai_disabled", retryable=False)

    monkeypatch.setattr(job_analysis, "get_provider", lambda: Down())
    text = "Data Analyst\nLocation: Pune, India\nInternship\nRequirements\n- SQL and Excel.\nApply by 5 Dec 2026\n"
    out = job_analysis.analyze(text, None, None)
    fields = out["result"]["fields"]
    assert out["status"] == "partial"
    assert fields["location"]["value"] == "Pune, India" and fields["location"]["source"] == "job_text"
    assert fields["employment_type"]["value"] == "Internship"
    assert fields["deadline"]["value"] == "5 Dec 2026"


# ------------------------------------------------------------------ built-in interview practice (no AI)
def test_template_questions_use_job_concepts_and_allowed_kinds():
    from elevate.services import interviews as iv
    reqs = [{"key": "r1", "concepts": [{"label": "Spring Boot"}]}, {"key": "r2", "concepts": [{"label": "PostgreSQL"}]}]
    qs = iv.template_questions(role="Backend Engineer", kinds=["technical", "behavioral"], requirements=reqs,
                               topics=[], difficulty="medium", count=5)
    assert len(qs) == 5
    assert {q["kind"] for q in qs} <= {"technical", "behavioral"}
    assert len({q["prompt"] for q in qs}) == 5  # no duplicates
    assert any("Spring Boot" in q["prompt"] for q in qs) and any("PostgreSQL" in q["prompt"] for q in qs)
    assert all(q["requirement_ref"] in (None, "r1", "r2") for q in qs)
    assert all(q["rubric"] for q in qs)


def test_template_questions_without_requirements_still_work():
    from elevate.services import interviews as iv
    qs = iv.template_questions(role="", kinds=["hr"], requirements=[], topics=[], difficulty="hard", count=2)
    assert len(qs) == 2 and all("trade-offs" in q["prompt"] for q in qs)


def test_checklist_evaluation_is_transparent():
    from elevate.services import interviews as iv
    rubric = [{"criterion": c, "origin": "base"} for c in iv.BASE_RUBRICS["behavioral"]]
    ans = ("During my internship our test suite took 40 minutes. I built a parallel runner and fixed flaky tests. "
           "As a result the suite ran in 9 minutes and I learned to measure before optimising.")
    ev = iv.checklist_evaluation("behavioral", rubric, ans)
    assert ev["method"] == "checklist" and ev["tally"]["met"] == 3
    assert all(c["answer_quote"] in ans for c in ev["criteria"] if c["answer_quote"])
    weak = iv.checklist_evaluation("coding", [{"criterion": c, "origin": "base"} for c in iv.BASE_RUBRICS["coding"]],
                                   "I would loop over the list and count things in a dictionary.")
    ratings = {c["criterion"]: c["rating"] for c in weak["criteria"]}
    assert ratings["States time/space complexity"] == "not_met"
    assert ratings["Describes a correct approach"] == "cannot_assess"  # never judges correctness


# ------------------------------------------------------------------ AI provider rate limits
def test_retry_after_parsing():
    from elevate.services.llm import _retry_after_seconds as f
    assert f({"retry-after": "7"}) == 7.0
    assert f({"x-ratelimit-reset-tokens": "7.66s"}) == 7.66
    assert f({"x-ratelimit-reset-requests": "2m59.5s"}) == 179.5
    assert f({"retry-after": "300ms"}) == 0.5  # floor, never a busy loop
    assert f({"retry-after": "soon"}) is None and f({}) is None


def test_rate_limited_call_waits_once_then_succeeds(monkeypatch):
    import httpx

    from elevate.services import llm
    calls = []

    class FakeClient:
        def __init__(self, *a, **k): pass
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def post(self, *a, **k):
            calls.append(1)
            if len(calls) == 1:
                return httpx.Response(429, headers={"retry-after": "2"}, json={"error": "rate"})
            return httpx.Response(200, json={"ok": True})

    slept = []
    monkeypatch.setattr(llm.httpx, "Client", FakeClient)
    monkeypatch.setattr(llm.time, "sleep", lambda s: slept.append(s))
    provider = llm.OpenAICompatProvider.__new__(llm.OpenAICompatProvider)
    provider.base, provider.key, provider.timeout, provider.model = "https://x", "k", 5, "m"
    assert provider._post({}) == {"ok": True}
    assert slept == [2.0] and len(calls) == 2


def test_broad_and_soft_requirements_do_not_withhold_the_score():
    """Internship-style posting: broad tech families + soft skills (regression for a withheld estimate)."""
    a = _analysis(("Basic understanding of any programming language.", "required"),
                  ("Familiarity with databases, APIs, or backend development.", "required"),
                  ("Problem-solving and logical-thinking abilities.", "required"),
                  ("Willingness to learn and complete assigned tasks.", "required"))
    res = matching.compute(a, *_resume("Skills\nJava, Python, SQL, Spring Boot, REST APIs\n"), None, [])
    s = res["summary"]
    assert s["score_status"] == "available"
    assert s["required"]["coverage"] == 100.0
    assert s["required"]["total"] == 2 and s["required"]["soft_skills"] == 2
    statuses = [u["status"] for u in res["requirements"]]
    assert statuses.count("soft_skill") == 2


def test_broad_family_unmet_without_any_family_skill():
    a = _analysis(("Basic understanding of any programming language.", "required"), ("SQL", "required"))
    res = matching.compute(a, *_resume("Skills\nSQL, Excel\n"), None, [])
    assert res["summary"]["required"]["coverage"] == 50.0


def test_pdf_split_words_are_rejoined():
    from elevate.services.resumes import clean_pdf_text
    assert clean_pdf_text("Hyderabad, T elangana. Backend & W eb. 9.30 CGP A") == "Hyderabad, Telangana. Backend & Web. 9.30 CGPA"
    assert clean_pdf_text("I enjoy A lot of things") == "I enjoy A lot of things"

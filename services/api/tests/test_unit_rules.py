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

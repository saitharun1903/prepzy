"""Deterministic, explainable matching ("Your match score").

Scoring version score-2 (documented in docs/AI_EVALUATION.md#scoring):
  * Units: each non-removed, non-negated requirement after deduplication (same concepts+group+years
    or same normalized text). An alternatives group ("Python or R") is ONE unit.
  * Credit per unit:
      R1 single/any: 1.0 if any listed concept has evidence; all-of: evidenced/total concepts.
      R2 adjacent (taxonomy "related" only, no direct evidence): 0.25, labelled "adjacent".
      R3 user confirmation of a non-skill condition: met -> 1.0 (status user_confirmed), not met -> 0.
      R4 general experience years (no concepts) vs merged resume months: 1.0 if >= min, else 0;
         unassessable when the resume has no dated experience.
      R5 skill + years: presence credited, duration marked "not verified" (we never infer per-skill
         duration from total employment); unit counts as partially assessed in completeness (0.5).
      R5b if total dated experience < the stated years, the duration is provably unmet: credit capped at 0.5.
      R6 education: degree-level keyword match against the resume education section, else unassessable.
  * Location / work arrangement / work authorization conditions are shown for review, never scored.
  * coverage = 100 * sum(credit) / count(assessable units), separately for required and preferred.
      R7 broad families ("any programming language", "databases", "APIs", "backend"): any one family skill counts.
      R8 soft skills / attitudes (problem solving, willingness to learn …) without evidence: shown, never scored,
         and left out of totals so they cannot block the estimate.
  * Score withheld when there are no required units or none can be assessed; when completeness < 0.6 or fewer
    than min(2, total) required units are assessable, the score is shown as provisional (summary.provisional).
Keyword repetition never adds credit: evidence is per concept, boolean.
"""

from __future__ import annotations

import re
from typing import Any

from .resumes import effective_skills
from .taxonomy import load_taxonomy

SCORING_VERSION = "score-3"
ADJACENT_CREDIT = 0.25
MIN_COMPLETENESS = 0.6
MIN_ASSESSABLE = 2

_DEGREES = {
    "doctorate": r"\b(ph\.?d|doctorate|doctoral)\b",
    "master": r"\b(master'?s?|m\.?tech|m\.?sc|msc|mba|mca|m\.?s\.?|m\.?e\.?|m\.?com|postgraduate|pgdm)\b",
    "bachelor": r"\b(bachelor'?s?|b\.?tech|b\.?e\.?|b\.?sc|bsc|b\.?a\.?|b\.?com|bca|bba|undergraduate|graduate degree)\b",
    "diploma": r"\b(diploma)\b",
}
_LEVEL = {"diploma": 1, "bachelor": 2, "master": 3, "doctorate": 4}

# R7: broad technology families named without a specific tool ("any programming language", "databases").
# Any one listed concept with evidence satisfies the family (an alternatives group).
_FAMILIES: list[tuple[str, str, tuple[str, ...]]] = [
    (r"\b(programming|coding|scripting)\s+languages?\b|\bany\s+language\b", "A programming language",
     ("python", "java", "javascript", "typescript", "c_lang", "cpp", "csharp", "go", "kotlin", "rust", "ruby", "php",
      "swift", "r_lang")),
    (r"\bdatabases?\b|\bdbms\b|\bdata\s*stores?\b", "Databases",
     ("sql", "mysql", "postgresql", "mongodb", "redis", "nosql", "dbms")),
    (r"\bapis?\b|\bweb\s+services?\b", "APIs", ("rest_api", "graphql", "fastapi", "spring_boot", "nodejs", "django", "flask")),
    (r"\bback[\s-]?end\b|\bserver[\s-]side\b", "Backend development",
     ("spring_boot", "nodejs", "django", "flask", "fastapi", "dotnet", "rest_api", "microservices")),
    (r"\bfront[\s-]?end\b|\bui\s+development\b", "Frontend development",
     ("react", "angular", "vue", "nextjs", "html_css", "javascript", "typescript")),
    (r"\bcloud\b", "Cloud platforms", ("aws", "azure", "gcp")),
    (r"\bversion\s+control\b", "Version control", ("git",)),
]
# Soft skills and attitudes: shown for review and interview prep, never part of the coverage estimate.
_SOFT_TEXT = re.compile(r"\b(willing(ness)?|eager(ness)?|attitude|passion(ate)?|self[\s-]?motivat|curio(us|sity)|"
                        r"team\s*player|teamwork|interpersonal|communication|problem[\s-]?solving|logical[\s-]?thinking|"
                        r"analytical\s+(skills|thinking|mind)|quick\s+learner|learn(ing)?\s+new|adaptab|work\s+ethic|"
                        r"punctual|dedicat|enthusias|ownership|initiative|detail[\s-]oriented)\b", re.IGNORECASE)


def _degree_level(text: str) -> int | None:
    best = None
    for name, pat in _DEGREES.items():
        if re.search(pat, text, re.IGNORECASE):
            best = max(best or 0, _LEVEL[name])
    return best


def _excerpt(text: str, span: list[int] | None, pad: int = 70) -> str | None:
    if not text or not span:
        return None
    s, e = max(0, span[0] - pad), min(len(text), span[1] + pad)
    return ("…" if s else "") + text[s:e].replace("\n", " ").strip() + ("…" if e < len(text) else "")


def compute(analysis_result: dict[str, Any], resume_text: str | None, resume_extracted: dict[str, Any] | None,
            resume_reviewed: dict[str, Any] | None, facts: list[dict[str, Any]]) -> dict[str, Any]:
    tax = load_taxonomy()
    skills = effective_skills(resume_extracted, resume_reviewed)
    fact_skills = {f["concept_id"]: f for f in facts if f.get("kind") == "skill" and f.get("concept_id")}
    months = (resume_reviewed or {}).get("experience_months_override")
    if months is None:
        months = (resume_extracted or {}).get("experience_months")
    edu_text = " ".join(e["text"] for e in (resume_extracted or {}).get("education", []))
    edu_level = _degree_level(edu_text) if edu_text else None

    def evidence_for(cid: str) -> dict[str, Any] | None:
        if cid in skills:
            s = skills[cid]
            src = "user_review" if s["source"] == "user_review" else "resume"
            return {"concept_id": cid, "label": s["label"], "type": s["evidence_type"], "source": src,
                    "excerpt": _excerpt(resume_text or "", s["spans"][0] if s["spans"] else None)}
        if cid in fact_skills:
            f = fact_skills[cid]
            return {"concept_id": cid, "label": tax.skills[cid].label, "type": f["evidence_type"],
                    "source": "profile", "excerpt": f.get("detail")}
        return None

    def adjacent_for(cid: str) -> dict[str, Any] | None:
        for have in list(skills) + list(fact_skills):
            if tax.related(cid, have):
                return {"concept_id": have, "label": tax.skills[have].label, "for": cid, "rule": "R2"}
        return None

    units: list[dict[str, Any]] = []
    conditions: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    seen: set[str] = set()

    for r in analysis_result.get("requirements", []):
        base = {"key": r["key"], "text": r["text"], "importance": r["importance"], "category": r["category"],
                "group": r["group"], "concepts": r["concepts"], "years": r.get("years")}
        if r.get("removed_by_user"):
            excluded.append({**base, "reason": "Removed by you"})
            continue
        if r.get("negated"):
            excluded.append({**base, "reason": "Stated as not required"})
            continue
        if r["category"] in ("location", "work_arrangement") or re.search(
                r"\b(work authori[sz]ation|visa|relocat|right to work|citizenship)\b", r["text"], re.IGNORECASE):
            conf = r.get("user_confirmation")
            conditions.append({**base, "user_confirmation": conf,
                               "note": "Shown for your review; not part of the coverage estimate."})
            continue
        cids = [c["id"] for c in r["concepts"]]
        family_label = None
        if not cids and r["category"] not in ("experience", "education"):
            found = [c for c in tax.find_in_text(r["text"]) if c in tax.skills]
            if found:
                cids = found
                base["concepts"] = [{"id": c, "label": tax.skills[c].label} for c in found]
                base["group"] = "any" if len(found) > 1 else "single"
            fam = [(lbl, ids) for pat, lbl, ids in _FAMILIES if re.search(pat, r["text"], re.IGNORECASE)]
            if fam:
                fam_ids = [i for _, ids in fam for i in ids if i in tax.skills and i not in cids]
                cids = list(dict.fromkeys(cids + fam_ids))
                family_label = " / ".join(lbl for lbl, _ in fam)
                base["group"] = "any"
        is_soft = (not cids or all(tax.skills[c].kind == "soft" for c in cids if c in tax.skills)) and \
            bool(_SOFT_TEXT.search(r["text"])) and r["category"] not in ("experience", "education")
        sig = f"{sorted(cids)}|{r['group']}|{(r.get('years') or {}).get('min')}" if cids else \
            re.sub(r"\W+", " ", r["text"].lower()).strip()
        if sig in seen:
            excluded.append({**base, "reason": "Duplicate of an earlier requirement"})
            continue
        seen.add(sig)

        unit: dict[str, Any] = {**base, "evidence": [], "adjacent": [], "missing": [], "notes": list(r.get("notes", [])),
                                "status": "unassessable", "credit": 0.0, "assessed_weight": 0.0, "rule": None}
        conf = r.get("user_confirmation")
        if cids:
            ev = {c: evidence_for(c) for c in cids}
            have = [c for c in cids if ev[c]]
            unit["evidence"] = [ev[c] for c in have]
            unit["missing"] = [{"id": c, "label": tax.skills[c].label} for c in cids if not ev[c]]
            if base["group"] == "all":
                credit = len(have) / len(cids)
                unit["rule"] = "R1-all"
            else:
                credit = 1.0 if have else 0.0
                unit["rule"] = "R1-any" if base["group"] == "any" else "R1"
            if family_label:
                unit["rule"] = "R7"
                unit["notes"].append(f"Broad requirement ({family_label}): any one of the listed skills counts.")
                if have:
                    unit["missing"] = []
            if credit < 1.0:
                adj = [a for a in (adjacent_for(c["id"]) for c in unit["missing"]) if a]
                if adj and credit == 0.0:
                    unit["adjacent"] = adj
                    credit, unit["rule"] = ADJACENT_CREDIT, "R2"
            unit["credit"] = round(credit, 3)
            unit["assessed_weight"] = 1.0
            if credit >= 1.0:
                only_self = all(e["source"] != "resume" for e in unit["evidence"])
                unit["status"] = "user_confirmed" if only_self else "supported"
            elif unit["rule"] == "R2":
                unit["status"] = "adjacent"
            elif credit > 0:
                unit["status"] = "partial"
            else:
                unit["status"] = "not_evidenced"
            yrs = r.get("years") or {}
            if yrs.get("min") and credit > 0:
                if months is not None and months < yrs["min"] * 12:
                    # Total dated experience is an upper bound on any single skill's duration.
                    unit["credit"] = round(min(credit, 0.5), 3)
                    unit["status"] = "partial"
                    unit["notes"].append(f"Skill evidenced, but your dated experience ({months} months) is below the "
                                         f"{yrs['min']}+ years stated.")
                    unit["rule"] = (unit["rule"] or "") + "+R5b"
                else:
                    unit["notes"].append(f"Requires {yrs['min']}+ years; per-skill duration is not verified from your resume.")
                    unit["assessed_weight"] = 0.5
                    unit["rule"] = (unit["rule"] or "") + "+R5"
        elif conf is not None:
            unit["status"] = "user_confirmed" if conf["met"] else "not_met_confirmed"
            unit["credit"] = 1.0 if conf["met"] else 0.0
            unit["assessed_weight"], unit["rule"] = 1.0, "R3"
        elif r["category"] == "experience" and (r.get("years") or {}).get("min"):
            if months is None:
                unit["notes"].append("Your resume has no dated experience entries to compare against.")
            else:
                need = r["years"]["min"] * 12
                unit["credit"] = 1.0 if months >= need else 0.0
                unit["status"] = "supported" if months >= need else "not_evidenced"
                unit["assessed_weight"], unit["rule"] = 1.0, "R4"
                unit["evidence"] = [{"type": "calculated", "source": "resume",
                                     "label": f"{months // 12} yr {months % 12} mo of dated experience (overlaps counted once)"}]
        elif r["category"] == "education":
            need = _degree_level(r["text"])
            if need and edu_level:
                ok = edu_level >= need
                unit["credit"], unit["status"] = (1.0, "supported") if ok else (0.0, "not_evidenced")
                unit["assessed_weight"], unit["rule"] = 1.0, "R6"
                unit["evidence"] = [{"type": "education", "source": "resume", "label": "Degree level in Education section",
                                     "excerpt": edu_text[:160]}]
                unit["notes"].append("Field of study is not compared automatically.")
            else:
                unit["notes"].append("Confirm whether you meet this; it can't be checked automatically.")
        else:
            unit["notes"].append("Confirm whether you meet this; it can't be checked automatically.")
        if is_soft and unit["status"] not in ("supported", "user_confirmed", "not_met_confirmed"):
            unit.update(status="soft_skill", credit=0.0, assessed_weight=0.0, missing=[], rule="R8")
            unit["notes"] = ["A soft skill: employers judge this in the interview, so it isn't scored. "
                             "Prepare a short example that shows it."]
        units.append(unit)

    def summarize(imp: str) -> dict[str, Any]:
        us = [u for u in units if u["importance"] == imp and u["status"] != "soft_skill"]
        assessable = [u for u in us if u["assessed_weight"] > 0]
        weight = sum(u["assessed_weight"] for u in us)
        cov = round(100 * sum(u["credit"] for u in assessable) / len(assessable), 1) if assessable else None
        return {
            "total": len(us), "assessable": len(assessable),
            "completeness": round(weight / len(us), 2) if us else None,
            "coverage": cov,
            "counts": {k: sum(1 for u in us if u["status"] == k) for k in
                       ("supported", "user_confirmed", "partial", "adjacent", "not_evidenced", "not_met_confirmed",
                        "unassessable")},
            "soft_skills": sum(1 for u in units if u["importance"] == imp and u["status"] == "soft_skill"),
        }

    req, pref, unclear = summarize("required"), summarize("preferred"), summarize("unclear")
    status, reason, provisional = "available", None, False
    if req["total"] == 0:
        status, reason = "withheld", ("This posting only lists soft skills or no checkable requirements, so there is "
                                      "nothing to score. Use the interview prep instead." if any(
                                          u["status"] == "soft_skill" for u in units) else
                                      "No required qualifications were identified; review the requirements.")
    elif req["assessable"] == 0:
        status, reason = "withheld", ("Prepzy can't check any of the required items automatically. Tick "
                                      "\"I have this\" on the items below to get your score.")
    elif (req["completeness"] or 0) < MIN_COMPLETENESS or req["assessable"] < min(MIN_ASSESSABLE, req["total"]):
        # Show what we can measure, clearly labelled, instead of hiding the score entirely.
        provisional = True
        reason = (f"Based on the {req['assessable']} of {req['total']} required items Prepzy could check. Tick "
                  "\"I have this\" on the rest to make it accurate.")
    if status == "withheld":
        req = {**req, "coverage": None}

    priorities: list[dict[str, Any]] = []
    for imp, weight in (("required", 2), ("unclear", 1), ("preferred", 1)):
        for u in units:
            if u["importance"] != imp or u["status"] in ("supported", "user_confirmed"):
                continue
            for m in u["missing"]:
                if not any(p["concept_id"] == m["id"] for p in priorities):
                    priorities.append({"concept_id": m["id"], "label": m["label"], "importance": imp,
                                       "requirement_key": u["key"], "adjacent": bool(u["adjacent"]),
                                       "priority": "high" if weight == 2 and not u["adjacent"] else "medium"
                                       if weight == 2 else "low"})
    return {
        "scoring_version": SCORING_VERSION,
        "label": "Your match score",
        "disclaimer": "Estimates how much of this posting's stated requirements your supplied evidence covers. "
                      "It is not a hiring probability or an employer's ATS score.",
        "summary": {"required": req, "preferred": pref, "unclear": unclear, "score_status": status,
                    "withheld_reason": reason, "provisional": provisional},
        "requirements": units,
        "conditions": conditions,
        "excluded": excluded,
        "priorities": priorities,
        "evidence_basis": {"resume_skills": len(skills), "profile_skills": len(fact_skills),
                           "experience_months": months, "education_level_detected": edu_level},
    }

"""Deterministic roadmap planning.

Inputs: match-report priorities (missing/adjacent concepts) or, when no evidence is available, a
clearly-labelled *generic starter plan* for the profile's domains. Prerequisites come from the
taxonomy (only those the candidate lacks evidence for); cycles are detected and reported. Effort
estimates are coarse ranges by skill kind (documented, not personalised measurements). Resources
are drawn only from the knowledge library (with provenance); otherwise the task is labelled
self-directed — no URL is ever invented.
"""

from __future__ import annotations

import math
from datetime import date, timedelta
from typing import Any

from .taxonomy import load_taxonomy

PLANNER_VERSION = "plan-1"
EFFORT = {"tool": (6, 12), "technical": (10, 25), "domain": (8, 20), "soft": (4, 8)}
PRIORITY_RANK = {"high": 0, "medium": 1, "low": 2}


def _toposort(nodes: list[str], deps: dict[str, list[str]]) -> tuple[list[str], list[list[str]]]:
    order: list[str] = []
    state: dict[str, int] = {}
    cycles: list[list[str]] = []

    def visit(n: str, path: list[str]) -> None:
        if state.get(n) == 2:
            return
        if state.get(n) == 1:
            cycles.append(path[path.index(n):] + [n])
            return
        state[n] = 1
        for d in deps.get(n, []):
            visit(d, path + [n])
        state[n] = 2
        order.append(n)

    for n in nodes:
        visit(n, [])
    return order, cycles


def plan(priorities: list[dict[str, Any]], evidenced: set[str], weekly_hours: int, start: date,
         target_date: date | None, resources_for: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    tax = load_taxonomy()
    wanted: dict[str, dict[str, Any]] = {}
    for p in priorities:
        if p["concept_id"] in tax.skills:
            wanted[p["concept_id"]] = {"priority": p.get("priority", "medium"), "requirement_key": p.get("requirement_key"),
                                       "reason": "Required by the job" if p.get("importance") == "required" else
                                       "Preferred by the job" if p.get("importance") == "preferred" else "Mentioned by the job"}
    # Expand missing prerequisites (bounded depth).
    frontier = list(wanted)
    for _ in range(3):
        nxt = []
        for sid in frontier:
            for pre in tax.skills[sid].prereqs:
                if pre not in evidenced and pre not in wanted and pre in tax.skills:
                    wanted[pre] = {"priority": wanted[sid]["priority"], "requirement_key": None,
                                   "reason": f"Prerequisite for {tax.skills[sid].label}"}
                    nxt.append(pre)
        frontier = nxt
    deps = {sid: [p for p in tax.skills[sid].prereqs if p in wanted] for sid in wanted}
    ordered_ids = sorted(wanted, key=lambda s: PRIORITY_RANK.get(wanted[s]["priority"], 1))
    order, cycles = _toposort(ordered_ids, deps)

    tasks: list[dict[str, Any]] = []
    for i, sid in enumerate(order):
        sk = tax.skills[sid]
        lo, hi = EFFORT.get(sk.kind, (8, 20))
        res = resources_for.get(sid, [])
        tasks.append({
            "key": f"learn:{sid}", "ord": i, "title": f"Build evidence for {sk.label}",
            "objective": (f"{wanted[sid]['reason']}. Study the fundamentals, then produce something you can show "
                          f"(a small project, write-up or worked example) — completing study alone does not prove the skill."),
            "skill_id": sid, "requirement_ref": wanted[sid]["requirement_key"], "priority": wanted[sid]["priority"],
            "est_hours_low": lo, "est_hours_high": hi,
            "depends_on": [f"learn:{d}" for d in deps.get(sid, [])],
            "resources": res or [{"kind": "self_directed", "title": "Self-directed study",
                                  "note": "No vetted resource for this skill is in the knowledge library yet."}],
        })
    # Review task at the end.
    if tasks:
        tasks.append({"key": "review:final", "ord": len(tasks), "title": "Review and update your resume evidence",
                      "objective": "Add genuine new evidence (projects, results) to your resume and re-run the comparison.",
                      "skill_id": None, "requirement_ref": None, "priority": "medium", "est_hours_low": 1,
                      "est_hours_high": 3, "depends_on": [t["key"] for t in tasks], "resources": []})
    return schedule(tasks, weekly_hours, start, target_date) | {"cycles": cycles}


def schedule(tasks: list[dict[str, Any]], weekly_hours: int, start: date, target_date: date | None) -> dict[str, Any]:
    """Assign weeks respecting dependencies and the weekly budget (by upper estimate)."""
    week_of: dict[str, int] = {}
    load: dict[int, float] = {}
    for t in sorted(tasks, key=lambda t: t["ord"]):
        if t.get("status") in ("done", "skipped"):
            week_of[t["key"]] = t.get("scheduled_week") or 1
            continue
        earliest = max([week_of.get(d, 1) for d in t.get("depends_on", [])] or [1])
        need = float(t["est_hours_high"])
        w = earliest
        while load.get(w, 0) > 0 and load.get(w, 0) + need > weekly_hours:
            w += 1
        weeks_span = max(1, math.ceil(need / max(1, weekly_hours)))
        for k in range(weeks_span):
            load[w + k] = load.get(w + k, 0) + need / weeks_span
        t["scheduled_week"] = w
        week_of[t["key"]] = w + weeks_span - 1
    remaining = [t for t in tasks if t.get("status") not in ("done", "skipped")]
    total_lo = sum(t["est_hours_low"] for t in remaining)
    total_hi = sum(t["est_hours_high"] for t in remaining)
    weeks_needed = max(week_of.values()) if week_of else 0
    finish = start + timedelta(weeks=weeks_needed)
    feas: dict[str, Any] = {"weekly_hours": weekly_hours, "total_hours_low": total_lo, "total_hours_high": total_hi,
                            "weeks_needed": weeks_needed, "estimated_finish": finish.isoformat(), "feasible": True}
    if target_date:
        avail_weeks = max(0, (target_date - start).days // 7)
        feas["available_weeks"] = avail_weeks
        if weeks_needed > avail_weeks:
            feas["feasible"] = False
            high_only = sum(t["est_hours_high"] for t in remaining if t["priority"] == "high")
            feas["suggestions"] = [
                f"Move the target date to about {finish.isoformat()}.",
                f"Increase weekly time to about {math.ceil(total_hi / max(1, avail_weeks))} hours." if avail_weeks else
                "Choose a later target date.",
                f"Focus only on high-priority items (~{high_only} hours).",
            ]
    return {"tasks": tasks, "feasibility": feas}


def generic_priorities(domains: list[str]) -> list[dict[str, Any]]:
    """Core skills per domain for a generic starter plan (labelled generic)."""
    tax = load_taxonomy()
    out = []
    for d in domains[:2]:
        core = [s for s in tax.skills.values() if d in s.domains and s.kind != "soft" and len(s.domains) <= 4]
        core.sort(key=lambda s: (len(s.prereqs), s.label))
        for s in core[:5]:
            out.append({"concept_id": s.id, "priority": "medium", "importance": "unclear", "requirement_key": None})
    return out


def merge_regeneration(current: list[dict[str, Any]], proposed: list[dict[str, Any]]) -> dict[str, Any]:
    """Preview: keep done/in-progress/user-edited tasks as they are; add new; mark obsolete
    untouched todo tasks for removal. Nothing is applied until the user accepts."""
    cur_by_key = {t["key"]: t for t in current}
    prop_by_key = {t["key"]: t for t in proposed}
    keep, add, remove, update = [], [], [], []
    for k, t in cur_by_key.items():
        protected = t["status"] in ("done", "in_progress", "skipped") or t["user_edited"]
        if k in prop_by_key:
            if protected:
                keep.append({"key": k, "title": t["title"], "reason": "completed or edited by you"})
            else:
                p = prop_by_key[k]
                if (p["est_hours_low"], p["est_hours_high"], p["priority"]) != (t["est_hours_low"], t["est_hours_high"], t["priority"]):
                    update.append({"key": k, "title": t["title"], "changes": {"priority": p["priority"]}})
                else:
                    keep.append({"key": k, "title": t["title"], "reason": "unchanged"})
        elif protected:
            keep.append({"key": k, "title": t["title"], "reason": "completed or edited by you (no longer needed)"})
        else:
            remove.append({"key": k, "title": t["title"]})
    for k, p in prop_by_key.items():
        if k not in cur_by_key:
            add.append({"key": k, "title": p["title"], "priority": p["priority"]})
    return {"keep": keep, "add": add, "remove": remove, "update": update}

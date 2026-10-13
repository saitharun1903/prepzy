"""Run the job-extraction evaluation against the CONFIGURED real model.

    cd services/api && uv run python ../../ai/evaluation/run_eval.py [--limit N]

Metrics (concept level, per case and per domain):
  * required/preferred concept precision, recall, F1 — a predicted concept counts if it appears in a
    requirement with that importance; gold = union of the case's labelled concept groups.
  * importance accuracy — share of gold concepts found with the labelled importance.
  * alternative-group accuracy — labelled alternative pairs that end up in ONE requirement with group "any".
  * salary_unknown_correct, negation detected, prompt-injection resistance (the analysis ignores
    embedded instructions: no field claims "100% qualified").
  * schema_valid (status complete without schema issues), latency.
Writes ai/evaluation/results/<timestamp>.json and latest.json. Sample sizes are tiny (n=1 per
domain): results are a baseline smoke measurement, NOT validation.
"""

from __future__ import annotations

import argparse
import json
import platform
import statistics
import time
from datetime import UTC, datetime
from pathlib import Path

from elevate.config import get_settings
from elevate.services import job_analysis
from elevate.services.taxonomy import load_taxonomy

ROOT = Path(__file__).resolve().parents[2]
DS = ROOT / "ai" / "evaluation" / "dataset" / "v1" / "cases.json"
OUT = ROOT / "ai" / "evaluation" / "results"
TARGETS = {"required_f1": 0.75, "alternative_accuracy": 0.8, "salary_unknown": 1.0, "schema_valid": 0.95}


def prf(pred: set[str], gold: set[str]) -> dict[str, float]:
    tp = len(pred & gold)
    p = tp / len(pred) if pred else (1.0 if not gold else 0.0)
    r = tp / len(gold) if gold else 1.0
    return {"precision": round(p, 3), "recall": round(r, 3), "f1": round(2 * p * r / (p + r), 3) if p + r else 0.0}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    data = json.loads(DS.read_text(encoding="utf-8"))
    cases = data["cases"][: args.limit or None]
    rows = []
    for c in cases:
        text = c.get("text") or (ROOT / c["file"]).read_text(encoding="utf-8")
        t0 = time.monotonic()
        out = job_analysis.analyze(text, None, None)
        secs = time.monotonic() - t0
        reqs = out["result"]["requirements"]
        e = c["expect"]
        pred = {imp: {cc["id"] for r in reqs if r["importance"] == imp for cc in r["concepts"]}
                for imp in ("required", "preferred", "unclear")}
        gold_req = {x for g in e["required"] for x in g}
        gold_pref = {x for g in e["preferred"] for x in g}
        all_pred = pred["required"] | pred["preferred"] | pred["unclear"]
        imp_ok = sum(1 for x in gold_req if x in pred["required"]) + sum(1 for x in gold_pref if x in pred["preferred"])
        alts = e.get("alternatives", [])
        alt_ok = sum(1 for pair in alts if any(r["group"] == "any" and set(pair) <= {cc["id"] for cc in r["concepts"]}
                                               for r in reqs))
        salary_known = out["result"]["fields"]["salary"]["value"] is not None
        row = {
            "id": c["id"], "domain": c["domain"], "status": out["status"], "model": out["model"],
            "seconds": round(secs, 1), "n_requirements": len(reqs),
            "required": prf(pred["required"], gold_req), "preferred": prf(pred["preferred"], gold_pref),
            "any_importance": prf(all_pred, gold_req | gold_pref),
            "importance_accuracy": round(imp_ok / max(1, len(gold_req | gold_pref)), 3),
            "alternatives": {"labelled": len(alts), "correct": alt_ok},
            "salary_correct": salary_known == e["salary_known"],
            "negation_detected": (any(r["negated"] for r in reqs) if e.get("negated_present") else None),
            "injection_resisted": (not any("100%" in json.dumps(f) for f in out["result"]["fields"].values())
                                   if e.get("injection") else None),
            "domain_top": (out["result"]["domains"][0]["id"] if out["result"]["domains"] else None),
            "domain_correct": bool(out["result"]["domains"]) and out["result"]["domains"][0]["id"] in e["domains"],
            "issues": [i["code"] for i in out["issues"]],
        }
        rows.append(row)
        print(json.dumps({k: row[k] for k in ("id", "status", "seconds", "required", "preferred", "importance_accuracy",
                                              "alternatives", "salary_correct", "domain_correct", "issues")}))

    def mean(xs: list[float]) -> float:
        return round(statistics.mean(xs), 3) if xs else 0.0
    alts_l = sum(r["alternatives"]["labelled"] for r in rows)
    agg = {
        "cases": len(rows),
        "required_f1": mean([r["required"]["f1"] for r in rows]),
        "preferred_f1": mean([r["preferred"]["f1"] for r in rows]),
        "any_importance_f1": mean([r["any_importance"]["f1"] for r in rows]),
        "importance_accuracy": mean([r["importance_accuracy"] for r in rows]),
        "alternative_accuracy": round(sum(r["alternatives"]["correct"] for r in rows) / alts_l, 3) if alts_l else None,
        "salary_unknown": mean([1.0 if r["salary_correct"] else 0.0 for r in rows]),
        "schema_valid": mean([1.0 if r["status"] == "complete" else 0.0 for r in rows]),
        "domain_accuracy": mean([1.0 if r["domain_correct"] else 0.0 for r in rows]),
        "latency_s": {"median": round(statistics.median([r["seconds"] for r in rows]), 1) if rows else None,
                      "max": max((r["seconds"] for r in rows), default=None)},
    }
    by_domain = {r["domain"]: {"status": "measured_experimental", "cases": 1, "required_f1": r["required"]["f1"],
                               "note": "n=1 baseline; not validated"} for r in rows}
    s = get_settings()
    report = {
        "run_at": datetime.now(UTC).isoformat(), "dataset": data["version"], "labeling": data["labeling"],
        "model": s.llm_model, "prompt_version": job_analysis.PROMPT_VERSION, "schema_version": job_analysis.SCHEMA_VERSION,
        "taxonomy_version": load_taxonomy().version, "temperature": s.llm_temperature, "num_ctx": s.llm_num_ctx,
        "environment": {"os": platform.platform(), "python": platform.python_version(),
                        "hardware": "i5-12500H, 16 GB RAM, RTX 3050 Laptop 4 GB (model partially CPU-offloaded)"},
        "targets": TARGETS, "aggregate": agg, "by_domain": by_domain, "cases": rows,
        "limitations": ["One case per domain; single author labels; English only; authored fixtures, not live postings."],
    }
    OUT.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    for name in (f"{stamp}.json", "latest.json"):
        (OUT / name).write_text(json.dumps(report, indent=1), encoding="utf-8")
    print("AGGREGATE", json.dumps(agg))


if __name__ == "__main__":
    main()

# AI evaluation

## What is evaluated
Job requirement extraction (the core AI step) with the **real configured model**. Matching, scheduling and scoring are deterministic and covered by unit/integration tests instead.

* Dataset `eval-v1` — `ai/evaluation/dataset/v1/cases.json`: 10 authored, fictional postings, **one per domain** (software, data, AI/ML, cloud/DevOps, cybersecurity, digital marketing, business analysis, sales/CS, HR, finance). Includes alternatives ("Python or R", "Power BI or Tableau", "AWS or Azure"), a stated salary (da-1), an undisclosed one (sales-1), a negated requirement (sec-1) and a prompt-injection line (mkt-1).
* Labels: written by one author (the agent that built Elevate); **not independently reviewed** — a known weakness.
* Runner: `cd services/api && uv run python ../../ai/evaluation/run_eval.py`. Results: `ai/evaluation/results/<stamp>.json` and `latest.json` (also read by `GET /taxonomy/domains` for per-domain status).

## Environment
Windows 11, i5-12500H, 16 GB RAM, RTX 3050 Laptop 4 GB (7B model partly CPU-offloaded); Ollama 0.35; `qwen2.5-coder:7b`, temperature 0.1, num_ctx 8192; taxonomy `tax-2026.10.1`; schema `job-analysis-1`.

## Targets (set before the candidate run) and results
| Metric | Target | Baseline (prompt `job-extract-3`) | Candidate (`job-extract-4` + section gap-fill) |
|---|---|---|---|
| Required-concept F1 | ≥ 0.75 | 0.971 | **0.971** |
| Preferred-concept F1 | (no target set) | **0.000** | **0.919** |
| Any-importance concept F1 | — | 0.840 | 0.959 |
| Importance accuracy | — | 0.728 | 0.946 |
| Alternative-group accuracy (n=5 groups) | ≥ 0.8 | 1.0 | 1.0 |
| Salary stays unknown when absent / found when stated | 1.0 | 1.0 | 1.0 |
| Schema-valid complete analyses | ≥ 0.95 | 1.0 | 1.0 |
| Top domain correct | — | 1.0 | 1.0 |
| Latency per posting (median / max) | — | 55.5 s / 67.2 s | 43.8 s / 68.5 s |

Finding: the 7B model systematically stopped after the "Requirements" list and omitted every "Nice to have/Preferred" item; a stronger prompt alone did not fix it. A deterministic step now adds requirement-section bullets with known skills that the model missed, labelled `method: "rules"` with an analysis issue `rules_gap_fill`, importance taken from the section heading.

Remaining errors: sales-1 and hr-1 required recall 0.75 (taxonomy phrasing gaps, e.g. "B2B or SaaS sales" is not a reviewed alias of consultative selling); ml-1 preferred recall 0.5; swe-1/ba-1 preferred precision < 1 (a "Plus"-section line yielded an extra concept).

Additional checks run via tests (not the model): repeated keywords don't inflate coverage; either alternative satisfies "Python or R"; marketing roles get no coding/DSA/system-design question kinds; generated questions are labelled `origin: generated`; fabricated quotes in answer evaluations and unsupported citations are removed.

## Not measured yet (honest gaps)
* Matching explanations vs. human judgement, retrieval relevance/citation support on a real corpus (the shared knowledge library is empty — no permissioned corpus was supplied), resume parsing coverage by format on real resumes, interview-question quality, non-English inputs (detected and flagged, not supported).
* Per-domain status is therefore **`measured_experimental` (n=1)**, never "validated". Expanding to ≥ 20 reviewed cases per domain with a second labeller is the next evaluation step.

## Fine-tuning
Not started. Gate (spec §18) not met: the baseline gap found was fixed by deterministic rules; no reviewed training data or suitable GPU (4 GB VRAM) exists.

## Scoring (score-1)
Documented in `services/api/src/elevate/services/matching.py` (rules R1–R6, R5b). Label: "Elevate evidence coverage estimate"; required/preferred reported separately with completeness; withheld when completeness < 0.6 or fewer than 2 assessable required units.

# Requirements traceability

Status labels (spec §1.5): **Implemented** (code connected) · **Locally verified** (automated checks + actual local workflow passed) · **Partial** · **Blocked** · **Not started** · **Gated** (optional, prerequisites unmet). Evidence keys: `UT` unit tests, `IT` integration tests (`services/api/tests`), `SMOKE` `scripts/smoke_e2e.py` with the real model, `EVAL` `ai/evaluation`, `UI` browser walkthrough of the production web build (2026-10-13), `EXT` extension test suite.

| ID | Requirement (spec §) | Status | Code | Evidence |
|---|---|---|---|---|
| R-01 | Auth: register/login/logout/refresh/expiry, protected routes (§16) | Locally verified | `security.py`, `routers/auth.py`, `apps/web/src/lib/server/session.ts`, `src/proxy.ts` | IT refresh rotation/reuse; UI register → onboarding; dead-session → /login (bug found + fixed during UI walkthrough) |
| R-02 | Account recovery | Partial | `cli.py reset-password` | Operator-only (no email in ₹0 local profile); documented |
| R-03 | Extension sign-in handoff (§16) | Implemented | `/extension/connect`, `auth/extension-grant`, extension SW | EXT (mocked chrome); **not run in a real browser** |
| R-04 | Empty new accounts, no fabricated data (§2.1) | Locally verified | — | IT `test_new_account_is_empty`; SMOKE; UI Home |
| R-05 | Extension extraction from originating tab, bounded, adapters, multi-job detection (§6.2) | Implemented | `apps/extension/src` | EXT 101 tests on fixtures; live sites **unverified** |
| R-06 | Operation states, recovery, no stale tab results (§6.3) | Implemented (ext) / Locally verified (API) | `operations.py`, extension state machine | IT lease/fencing/cancel; EXT state machine; UI real stages |
| R-07 | Manual job text first-class (§1.3) | Locally verified | `/jobs/new`, `jobs/capture` | SMOKE, UI |
| R-08 | Job analysis with real model, schema + evidence validation (§7.4, §8) | Locally verified | `job_analysis.py` | SMOKE, EVAL (10 cases), IT invented-salary dropped |
| R-09 | Requirement semantics: alternatives, thresholds, negation, importance (§8) | Locally verified | `job_text.py`, `job_analysis.py` | UT; EVAL alternative accuracy 1.0 |
| R-10 | Unknown stays unknown; corrections with provenance (§8) | Locally verified | `job_corrections`, `effective_analysis` | IT; UI badges "Not stated", "From posting text" |
| R-11 | Save, dedupe, idempotency, open exact job route (§6.4) | Locally verified | `upsert_job`, idempotency | IT concurrent capture; SMOKE |
| R-12 | Resume upload/parse/review/versions/export/delete (§9) | Locally verified | `resumes.py` | IT (DOCX, bad files, scanned PDF), web agent proxy upload, UI |
| R-13 | Scanned/unsupported files handled honestly | Locally verified | `extract_text` | IT scanned PDF → `unsupported` |
| R-14 | Resume suggestions without fabrication; new version | Implemented | `handlers_more.resume_suggest` | Validator code; **not run against the real model** |
| R-15 | ATS guidance without proprietary claims or single score (§9.4) | Implemented | `ats_findings` | Unit-level via IT; UI tab renders |
| R-16 | Taxonomy, 10 domains, capability matrix (§10) | Implemented | `taxonomy.v1.json`, `GET taxonomy/domains` | UT; per-domain status `measured_experimental` |
| R-17 | Deterministic explainable matching, withheld scores (§11) | Locally verified | `matching.py` | UT regressions; UI match report |
| R-18 | Stale reports on input change, history kept (§7.5) | Locally verified | `routers/matching.py` | IT stale after resume review |
| R-19 | Authorized ingestion + RAG + citations (§7.2–7.3) | Partial | `rag.py`, `handlers_more` | IT private isolation/insufficient evidence (fake embeddings); real `nomic-embed-text` path **not exercised**; shared corpus empty (no permissioned sources supplied) |
| R-20 | Job-specific cited Q&A (§1.4 enhancement) | Implemented | `job_qa` | not run against real model |
| R-21 | Interview generation relevant to role; labelled generated (§12) | Locally verified | `interviews.py` | IT marketing→no coding; UI real-model session |
| R-22 | Mock interview with rubric evaluation, persisted, revisions | Locally verified | `answer_evaluate` | IT; UI real-model feedback (whole-answer quote issue found + fixed) |
| R-23 | Code execution absent / labelled (§12.3) | Locally verified | — | capability `code_execution:false`; UI labels |
| R-24 | Roadmaps: prerequisites, feasibility, edit, progress, safe regeneration (§13) | Locally verified | `roadmap.py`, `routers/roadmaps.py` | UT; IT; UI preview kept completed task |
| R-25 | Applications, transitions/corrections, history, notes, search (§14.1) | Locally verified | `routers/applications.py` | IT; SMOKE |
| R-26 | Durable reminders, timezone/DST, catch-up, idempotent (§14.2) | Locally verified | `scheduler.py` | UT DST; IT catch-up no duplicates |
| R-27 | External channels unavailable until configured (§14.3) | Locally verified | `/me` capabilities | UI settings |
| R-28 | Export + account deletion incl. files, pending work (§20.5) | Locally verified | `routers/account.py`, `scheduler.process_deletion_jobs` | IT recreation prevented; SMOKE; UI delete → files removed |
| R-29 | Cross-user denial: rows, files, vectors, ops, citations (§19.2-16) | Locally verified | RLS + filters | IT + SMOKE |
| R-30 | Worker crash/lease recovery, fencing, cancellation (§17.4) | Locally verified | `operations.py`, `worker.py` | IT |
| R-31 | AI outage keeps non-AI features usable (§3.6) | Implemented | partial analysis path | code path; **not tested with Ollama stopped** |
| R-32 | Security headers, CSRF, CSP, upload safety, no secrets in bundles | Locally verified | `main.py`, web proxy, `proxy.ts` | web agent curl checks; EXT validate (no keys bundled) |
| R-33 | Accessibility WCAG 2.2 AA targets (§5.2) | Partial | web components | UI: labels, focus return, Esc, 375 px reflow; **no automated axe scan, no full keyboard audit** |
| R-34 | Light/dark/reduced motion | Partial | `globals.css`, theme script | both themes rendered (web agent); reduced motion not audited |
| R-35 | Chrome AND Edge runtime verification (§19.2) | Blocked | — | Needs a user to enable Developer Mode / load unpacked |
| R-36 | Backup + isolated restore drill (§22.4) | Locally verified | `scripts/backup.py` | drill PASSED with 1 file verified |
| R-37 | Evaluation set, metrics, per-domain limits (§19.3) | Partial | `ai/evaluation` | n=1 per domain, single labeller |
| R-38 | Migrations clean install + drift | Locally verified | Alembic `0001` | IT runs from scratch each time; `alembic check` clean. Upgrade-from-prior: N/A (first schema) |
| R-39 | Dependency audit | Locally verified | — | `pip-audit` and `npm audit`: 0 known vulnerabilities |
| R-40 | Lint/format | Partial | ruff (API) | ruff clean (E501 relaxed); no ESLint for web |
| G-01 | Fine-tuning | Gated | — | gate not met (AI_EVALUATION.md) |
| G-02 | OCR | Gated | — | no tested local OCR |
| G-03 | Email / calendar sync / push | Gated | `.ics` download only | not configured |
| G-04 | Voice/video interviews, code runner | Gated | — | out of scope decision required |
| G-05 | Public deployment, store publication | Gated | DEPLOYMENT.md | requires authorization + beta prerequisites |

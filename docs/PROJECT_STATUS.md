# Project status — checkpoint 2026-10-13 (production preparation)

## Production readiness (latest)
* **Free deployment prepared** (`render.yaml`): Render free (web + API with embedded worker), Neon free, Groq free AI, resume files in Postgres. Container start path (bootstrap, migrations, embedded worker, db storage) smoke-tested locally; 67 API tests pass. Not verified: a real Groq call (needs your key), the Groq model's quality, a real Render deployment.
* **Prepared, not deployed.** Target: Render (web, API, worker, private Ollama) + Neon Postgres + S3-compatible storage; `render.yaml`, Dockerfiles, CI, runbook in DEPLOYMENT.md.
* Done and tested: email verification, password reset by email, lockout (no enumeration), TOTP two-step with recovery codes, PostgreSQL-shared rate limits, verified-email gate for AI, S3 storage backend, production config guard (secrets never echoed), HSTS, `/metrics`, non-root container (built and smoke-tested locally), dashboard screens for all of the above (agent-built; typecheck/build re-verified).
* Not yet verified: the Ollama image build (CI builds it), a real Render/Neon/R2/SMTP deployment, the production model's quality (qwen2.5:3b unevaluated), Edge runtime, store submission.
* Needs you: accounts and secrets (Render, Neon, bucket, SMTP), a domain (optional), approval to deploy and to spend (~$46-106/month, mostly inference).


## Readiness
* **Local release:** core product **implemented and largely locally verified** on this machine (see REQUIREMENTS.md). Not complete: Chrome/Edge runtime verification of the extension (R-35) is blocked on a manual browser step, and the items marked Partial below remain.
* **Public beta:** engineering prerequisites are in place (hardened auth, shared rate limits, TLS-only config guard, object storage, metrics, CI, deployment blueprint). Still required before launch: provisioning with your accounts, a monitored real deployment, evaluating the production model, and your approval. Nothing has been deployed or published.

## Checks run (latest results)
| Check | Command | Result |
|---|---|---|
| API lint | `uv run ruff check src tests --ignore E501` | pass |
| API tests | `uv run pytest -q` | **67 passed** (unit + integration on isolated DB with real RLS) |
| Migration drift | `uv run alembic check` | no changes |
| Real-service E2E | `python scripts/smoke_e2e.py` | **SMOKE OK** (real `qwen2.5-coder:7b`) |
| AI eval | `run_eval.py` | required F1 0.971, preferred F1 0.919 (baseline 0.0), alternatives 1.0, schema 1.0, median 43.8 s |
| Web | `npm run typecheck -w apps/web`, `npm run build -w apps/web` | pass |
| Web walkthrough | production build in browser | register → onboarding → capture (real stages) → requirements → match → roadmap + regenerate preview → interview generate + real feedback → settings delete; 1 bug fixed (dead session), 1 quality fix (whole-answer quotes) |
| Extension | typecheck, `test` (101), build, validate, build:release, package | pass |
| Backup/restore drill | `scripts/backup.py` | PASSED (rows + 1 file checksum) |
| Dependency audit | `pip-audit`, `npm audit` | 0 known vulnerabilities |

Not run: extension in real Chrome 154 / Edge 155 (needs Developer Mode, a user action); real-embedding RAG over a curated corpus; resume suggestions and job Q&A with the real model; AI-outage UI behaviour with Ollama stopped; automated accessibility scan; 15-min real access-token expiry in the web app.

## Next actions (in order)
1. **User:** load `apps/extension/dist` unpacked in Chrome and Edge (`chrome://extensions` → Developer mode → Load unpacked), connect via Settings → Connect browser extension, capture a posting. Record results in EXTENSION.md.
2. Supply permissioned knowledge documents (licence basis required) → `uv run python -m elevate.cli ingest …` → run real-embedding retrieval checks.
3. Real-model runs of resume suggestions and job Q&A; stop Ollama and check the partial-analysis UI.
4. Expand eval to ≥20 reviewed cases/domain with a second labeller; add taxonomy aliases for misses (e.g. "B2B sales" phrasing).
5. Add axe-core scan + keyboard audit; ESLint for web.
6. Before public launch: provision Render/Neon/bucket/SMTP with your accounts (DEPLOYMENT.md), evaluate the production model, wire alerts on `/metrics`, then deploy with your approval.

## Environment notes
* DB container `browserelevate-db` (compose project renamed after an unrelated "elevate" project collision removed the first container). An unrelated Supabase stack named `elevate` on this machine was not touched.
* Disk was 94% full at start; downloads limited to pgvector image + `nomic-embed-text` (user-approved).
* Services are started manually (README); logs in `data/logs/` (gitignored).

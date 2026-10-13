# Elevate

Evidence-based career preparation: capture a real job posting, see exactly which stated requirements your own evidence covers, prepare with a plan and practice interviews, and track applications. Everything runs locally: PostgreSQL + pgvector, a FastAPI API with a durable worker, a local Ollama model, a Next.js dashboard and a Chrome/Edge MV3 extension.

Elevate never predicts hiring outcomes. Its "Elevate evidence coverage estimate" only measures how much of a posting's stated requirements your supplied evidence covers, and it is withheld when too much can't be assessed.

> Status: **local release in progress** — see [docs/PROJECT_STATUS.md](docs/PROJECT_STATUS.md) for exactly what is verified, blocked or not yet done. Not deployed publicly.

## Prerequisites (tested on Windows 11)
* Docker Desktop (Compose v2), Python 3.13 + [uv](https://docs.astral.sh/uv/), Node 20+ (tested 24), Git
* [Ollama](https://ollama.com) with `qwen2.5-coder:7b` (≈4.7 GB) and `nomic-embed-text` (≈274 MB)
* ~8 GB free RAM while the model runs; Chrome ≥120 or Edge ≥120 for the extension

## Quick start
```bash
python scripts/init_env.py                                       # creates .env with random local secrets
docker compose --env-file .env -f infrastructure/docker/compose.yml up -d
cd services/api
uv sync
uv run python ../../scripts/db_bootstrap.py                      # runtime role + Alembic migrations
ollama pull qwen2.5-coder:7b && ollama pull nomic-embed-text
uv run uvicorn elevate.main:app --host 127.0.0.1 --port 8000     # API (terminal 1)
uv run python -m elevate.worker                                   # worker (terminal 2)
cd ../.. && npm install
npm run dev -w apps/web                                           # dashboard http://localhost:3000 (terminal 3)
npm run build -w apps/extension                                   # then load apps/extension/dist unpacked
```
Admin (shared knowledge curation): add your email to `ELEVATE_ADMIN_EMAILS` in `.env` and sign in again.

## Configuration
All settings are documented in [.env.example](.env.example) (server-only vs public, required vs optional). Startup validates them; the AI endpoint/model are operator configuration only.

## Tests and checks
```bash
cd services/api
uv run ruff check src tests --ignore E501     # lint
uv run pytest -q                              # 33 unit + 15 integration (isolated DB "elevate_test")
uv run alembic check                          # model/migration drift
uv run python ../../ai/evaluation/run_eval.py # real-model extraction evaluation (slow)
python ../../scripts/smoke_e2e.py             # real-service end-to-end (API+worker+Ollama running)
python ../../scripts/backup.py backup && python ../../scripts/backup.py restore-drill backups/<stamp>
npm run gen:api                               # regenerate TS types from the live OpenAPI
npm run typecheck && npm run build:web && npm run build:extension
```

## Layout
```
apps/web            Next.js dashboard (+ server-side session/proxy)
apps/extension      MV3 extension (Chrome/Edge)
services/api        FastAPI API + worker (elevate package), Alembic migrations, tests
packages/api-client OpenAPI snapshot + generated TS types
database/reference-data/taxonomy   versioned skill taxonomy (10 domains)
ai/evaluation       labelled eval set, runner, results
infrastructure/docker  compose for PostgreSQL+pgvector
scripts             env init, DB bootstrap, smoke test, backup/restore drill, API type generation
docs                architecture, decisions, API, data model, security, privacy, evaluation, extension, deployment, requirements, status
```

## Troubleshooting
* `/health/ready` → 503: start the DB container. AI shows `reachable:false`: start Ollama; jobs still save with a labelled rules-only partial analysis.
* Operations stay `queued`: the worker isn't running (`uv run python -m elevate.worker`). `uv run python -m elevate.cli ops --failed` lists failures.
* Forgot password (no email in local mode): `uv run python -m elevate.cli reset-password you@example.com`.
* Port 5433 busy: change `ELEVATE_DB_PORT` and the URLs in `.env`.

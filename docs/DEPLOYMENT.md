# Deployment and operations

## Profiles
| Profile | Purpose | DB | Files | AI |
|---|---|---|---|---|
| `local` | single developer machine (verified) | Docker `browserelevate-db` :5433 loopback, DB `elevate` | `./data` | local Ollama |
| `test` | automated tests | DB `elevate_test` (dropped/recreated per run) | temp dir | fake provider at the interface boundary (integration tests) |
| `production` (free) | Render free + Neon free (prepared, **not deployed**) | Neon Postgres + pgvector, TLS | Postgres `stored_files` | Groq API (free tier) |
| `production` (paid) | Render + Neon + S3-compatible storage (prepared, **not deployed**) | Neon Postgres + pgvector, TLS | S3 bucket (e.g. Cloudflare R2) | private Ollama service (CPU) |

## Local runbook (Windows, verified)
```bash
python scripts/init_env.py                                   # .env with generated secrets (once)
docker compose --env-file .env -f infrastructure/docker/compose.yml up -d
cd services/api && uv sync && uv run python ../../scripts/db_bootstrap.py   # role + migrations
ollama pull nomic-embed-text                                  # LLM qwen2.5-coder:7b assumed installed
uv run uvicorn elevate.main:app --host 127.0.0.1 --port 8000  # terminal 1
uv run python -m elevate.worker                               # terminal 2
cd ../.. && npm install && npm run dev -w apps/web            # terminal 3 -> http://localhost:3000
```
Shutdown: Ctrl+C the processes (worker finishes in-flight work), `docker compose … stop`. Data persists in the `browserelevate_pg` volume and `./data`.

Health: `GET /health/live` (process), `GET /health/ready` (503 when the DB is down; reports queue depth, oldest queued age, last worker heartbeat, AI availability — AI outage does not make the API "not ready").

Operator commands: `uv run python -m elevate.cli status | ops [--failed] | retry <id> | reset-password <email> | ingest <file> --title … --license …`.

Migrations: `uv run alembic upgrade head` (owner role); never auto-run destructive migrations; `uv run alembic check` detects model/migration drift.

## Backup and restore
* `python scripts/backup.py backup` → `backups/<UTC stamp>/` (`pg_dump -Fc`, then file archive, manifest with row counts + file SHA-256).
* `python scripts/backup.py restore-drill backups/<stamp>` restores into a scratch DB `elevate_restore_drill` and scratch file dir, verifies counts and checksums, reports accounts deleted since the backup, and drops the scratch DB. It never touches the live DB.
* Real restore (manual, authorised only): stop API+worker → `pg_restore --clean` into `elevate` → restore `data/users` → **re-apply deletions**: for each `deletion_jobs` row created after the backup, delete the matching user again (subject hash = sha256(user id)) before reopening the service.
* Local RPO = time since the last backup (suggest daily); RTO ≈ minutes for this data size. Nothing is scheduled automatically.

Rollback: application versions can be rolled back while the schema is unchanged; schema `0001` is the baseline — any future destructive migration requires a forward fix or data restore.

## Resource notes (measured, this machine)
i5-12500H, 16 GB RAM, RTX 3050 4 GB. `qwen2.5-coder:7b` does not fit in 4 GB VRAM and partially runs on CPU: job analysis took ~88 s warm in the smoke test (see AI_EVALUATION.md for the distribution). Concurrency is 1 by design (`ELEVATE_LLM_CONCURRENCY`). Disk: C: had ~32 GB free at setup; images ≈ 0.64 GB (pgvector), models 4.7 GB + 0.27 GB.

## Free deployment (Render free + Neon free + Groq free): `render.yaml`

Everything runs on free tiers with no payment card: two Render **free** web services
(`elevate-web`, `elevate-api`), Neon's free Postgres, Groq's free AI API and a free SMTP sender.
Prices and limits were checked in October 2026; re-check them when you sign up.

| Piece | Free choice | What the free tier means |
|---|---|---|
| Dashboard | Render free web service | sleeps after ~15 min idle; the first visit then takes ~1 minute |
| API + worker | Render free web service (Docker), worker runs inside the API (`ELEVATE_EMBEDDED_WORKER=true`) | queued work pauses while asleep and resumes when it wakes; reminders are sent late, not lost |
| Database | Neon Free (0.5 GB) | migrations run at API start (free services have no pre-deploy step) |
| Resume files | Postgres table `stored_files` (`ELEVATE_STORAGE_BACKEND=db`, owner-scoped RLS) | no bucket needed; counts toward Neon's 0.5 GB |
| AI | Groq free tier, `openai/gpt-oss-120b` (`ELEVATE_LLM_PROVIDER=openai`) | ~30 requests/min, ~1,000/day, 8K tokens/min; very long postings are rejected as too long |
| Email | Brevo free, via its HTTPS API (`ELEVATE_EMAIL_BACKEND=brevo`, 300/day) | Render free blocks outbound SMTP ports (25/465/587), so SMTP cannot be used there; a verified sender address is enough |

**Privacy change:** with Groq, job text, resumes and interview answers are sent to Groq for processing
(Groq states API data is not used for training). Self-hosted Ollama keeps them on your own server: use
`infrastructure/render/render.paid.yaml` for that. Semantic knowledge search is off on Groq (no embeddings).
The Groq model's answer quality has not been evaluated yet (`ai/evaluation/run_eval.py`).

### Steps (you)
1. **Neon:** create a project in AWS Asia Pacific (Singapore), next to Render's singapore region. Owner connection string, with `postgresql://` changed to
   `postgresql+psycopg://`, is `ELEVATE_MIGRATION_DATABASE_URL`. Choose a strong `ELEVATE_DB_APP_PASSWORD`;
   `ELEVATE_DATABASE_URL` is the same string with user `elevate_app` and that password (keep `?sslmode=require`).
2. **Groq:** console.groq.com, API Keys, create a key: `ELEVATE_OPENAI_API_KEY`.
3. **Email:** Brevo, SMTP & API, **API keys**: create a key for `ELEVATE_BREVO_API_KEY`; verify a sender for
   `ELEVATE_EMAIL_FROM`. (SMTP does not work from Render free: outbound SMTP ports are blocked.)
4. **Data key:** `cd services/api && uv run python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"`
   gives `ELEVATE_DATA_KEY`; keep a copy in a password manager.
5. **Render:** sign up with GitHub, Blueprints, New Blueprint Instance, this repo (uses `render.yaml`).
   Enter the values above. For the addresses enter `https://elevate-web.onrender.com` (`ELEVATE_WEB_URL`,
   `ELEVATE_ALLOWED_ORIGINS`, `ELEVATE_APP_ORIGINS`) and `https://elevate-api.onrender.com` (`ELEVATE_API_URL`).
   Choose the **Free** instance type if asked.
6. After creation, compare those with the real service URLs in Render; if Render added a suffix, update
   the values and redeploy. Check `https://<api>/health/ready`: `database: ok`, `storage.backend: db`,
   `ai.reachable: true`.

## Paid deployment (Render + Neon + S3 + self-hosted Ollama): `infrastructure/render/render.paid.yaml`

Everything below is in the repo; nothing has been provisioned. Prices were checked in October 2026 from
[Render pricing](https://render.com/pricing.md) and [Neon pricing](https://neon.com/pricing); re-check them when you sign up.

| Component | Where | Plan (blueprint default) | Approx. cost |
|---|---|---|---|
| `elevate-web` (Next.js) | Render web service | `0.5c-512mb` | ~$7/mo |
| `elevate-api` (FastAPI, Docker) | Render web service, public HTTPS | `0.5c-512mb` | ~$7/mo |
| `elevate-worker` | Render background worker | `0.5c-512mb` | ~$7/mo |
| `elevate-ollama` | Render **private** service + 10 GB disk | `2c-4g` (qwen2.5:3b) | ~$85/mo + disk; `1c-2g` with qwen2.5:1.5b ~$25/mo |
| Postgres + pgvector | Neon | Free (0.5 GB, 100 CU-h) to start | $0, then paid as you grow |
| Resume files | Cloudflare R2 or any S3 | free tier to start | ~$0 |
| Email (verification, reset) | any SMTP provider (Resend, Brevo, SES...) | free tier to start | ~$0 |

Inference runs on CPU: expect ~30 s to 2 min per analysis with qwen2.5:3b. **The production model has not been evaluated yet.**
Run `ai/evaluation/run_eval.py` against it (set `ELEVATE_LLM_MODEL`) before launch and record the result in AI_EVALUATION.md.

### One-time setup (you)
1. **Neon:** create a project in a region near Render's (e.g. Singapore). Copy the owner connection string into `ELEVATE_MIGRATION_DATABASE_URL` (`postgresql+psycopg://...?sslmode=require`). Choose a strong password for the runtime role as `ELEVATE_DB_APP_PASSWORD`, and set `ELEVATE_DATABASE_URL=postgresql+psycopg://elevate_app:<that password>@<neon host>/<db>?sslmode=require`. `db_bootstrap.py` creates the role and the `vector` extension.
2. **Storage:** create a private bucket (R2: no public access) and an access key limited to that bucket, for `ELEVATE_S3_*`.
3. **Email:** create an SMTP credential with a verified sender domain, for `ELEVATE_SMTP_*` and `ELEVATE_EMAIL_FROM`.
4. **Data key:** `python -c "from cryptography.fernet import Fernet;print(Fernet.generate_key().decode())"` gives `ELEVATE_DATA_KEY`. Use the same value on API and worker and keep a copy in a password manager: losing it disables existing two-step enrolments.
5. **Render:** Dashboard, Blueprints, New Blueprint Instance, choose this repository, set the Blueprint path to `infrastructure/render/render.paid.yaml`, enter the prompted values. The blueprint generates `ELEVATE_JWT_SECRET` and `ELEVATE_METRICS_TOKEN`.
6. Set `ELEVATE_WEB_URL` / `ELEVATE_ALLOWED_ORIGINS` (API) and `ELEVATE_APP_ORIGINS` (web) to the web service's https URL (or your domain later).

### Release
* `autoDeploy` is off: deploy from Render once CI (`.github/workflows/ci.yml`) is green on `main`.
* The API's `preDeployCommand` runs `scripts/db_bootstrap.py`: idempotent role creation plus `alembic upgrade head`. Migrations are additive so far (0001 baseline, 0002 auth hardening); a failed migration stops the release before traffic moves.
* The API refuses to start in production with unsafe settings (http origins, localhost, missing SMTP/S3/metrics token/data key, non-TLS database) and never echoes config values into logs.
* Ollama pulls its models into the persistent disk on first start (several minutes). Until then `/health/ready` reports `ai.reachable=false` and AI requests are retried.

### Operate
* Health: `GET /health/live` (liveness), `GET /health/ready` (database, queue, worker heartbeat, AI, storage).
* Metrics: `GET /metrics` with `Authorization: Bearer $ELEVATE_METRICS_TOKEN` (Prometheus text; counts only). Suggested alerts: `elevate_queue_oldest_seconds > 900`, `elevate_operations_failed_last_hour > 10`, `elevate_worker_last_heartbeat_seconds > 600` while work is queued, `elevate_reminders_overdue > 0`.
* Logs: Render log stream (JSON with request/operation ids; no bodies or tokens).
* Account recovery: users reset passwords by email; operators can still run `python -m elevate.cli reset-password <email>` in a Render shell.
* Backups: Neon point-in-time restore (window depends on plan; Free is 6 h) plus a scheduled `pg_dump`; enable bucket versioning on R2/S3. After any restore, re-apply `deletion_jobs` created after the backup point.
* Rollback: redeploy the previous image in Render. Schema changes are additive; a destructive migration needs a forward fix or a data restore.

### Browser extension for production
`ELEVATE_EXT_API_URL=https://<api host> ELEVATE_EXT_WEB_URL=https://<web host> npm run build:release -w apps/extension && npm run package -w apps/extension`
produces `apps/extension/release/elevate-extension-<version>.zip` for the Chrome Web Store (and Edge Add-ons). After the store assigns the extension id, set `ELEVATE_EXTENSION_IDS` (API) and `NEXT_PUBLIC_ELEVATE_EXTENSION_ID` (web, then rebuild). Store submission needs your developer account and a privacy-policy URL (the dashboard's `/privacy`).

### Still your decision / not done
* No domain yet: Render's `*.onrender.com` URLs work; a custom domain needs DNS changes by you.
* The production model's quality is unmeasured (see above). More than a handful of concurrent analyses needs a bigger inference plan or a GPU host.
* No monitoring service is wired; `/metrics` is ready for one (e.g. Grafana Cloud's free tier).

## Free deployment, single service (current): `render.yaml` → `prepzy`

The web app and the API now run in ONE free Render service (`infrastructure/render/prepzy.Dockerfile`,
started by `scripts/start_prepzy.py`): Next.js listens on `$PORT` and forwards `/api/v1/*`, `/health/*` and
`/metrics` to the API on `127.0.0.1:8000` (embedded worker). One always-on free instance (~720 h/month) fits
Render's 750 free hours; two do not. Keep it awake with a free uptime monitor (e.g. UptimeRobot) pinging
`https://<service>.onrender.com/health/live` every 10 minutes. The old `elevate-web` service redirects to
the new address when `ELEVATE_REDIRECT_ORIGIN` is set on it. Memory use measured locally: ~260 MB of 512 MB.

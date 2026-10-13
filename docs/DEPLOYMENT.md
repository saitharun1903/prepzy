# Deployment and operations

## Profiles
| Profile | Purpose | DB | Files | AI |
|---|---|---|---|---|
| `local` | single developer machine (verified) | Docker `browserelevate-db` :5433 loopback, DB `elevate` | `./data` | local Ollama |
| `test` | automated tests | DB `elevate_test` (dropped/recreated per run) | temp dir | fake provider at the interface boundary (integration tests) |
| `production` | **not deployed; not approved** | managed PG + pgvector | private object storage | an inference host with capacity |

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

## Public beta prerequisites (not met)
A laptop model is not a public service. A beta needs: TLS-terminated hosting for web+API, managed PostgreSQL with pgvector and backups, private object storage, an inference host sized for concurrent users (or an explicitly disclosed external provider), a maintained OIDC auth provider, a distributed rate limiter, monitoring/alerting with an owner, reviewed privacy/permission disclosures, and extension-store listing review. Do not expose ports 5433/11434 or use tunnels as a substitute. No hosting has been provisioned or priced; free-tier claims would need current terms verified at decision time.

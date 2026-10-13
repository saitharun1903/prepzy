# Data model

Source of truth: `services/api/src/elevate/models.py`; schema authority: Alembic (`services/api/migrations`, revision `0001`). RLS + grants: `elevate/migration_helpers.py`.

| Entity | Ownership / visibility | Key constraints | Versioning / history | Deletion |
|---|---|---|---|---|
| `users` | self | unique lower(email) | `token_version` for revocation | hard delete cascades everything below |
| `refresh_tokens` | user | unique token hash; client ∈ web/extension | family + used/revoked timestamps | cascade |
| `profiles` | user (RLS on `user_id`) | — | `revision` (optimistic concurrency, report staleness) | cascade |
| `profile_facts` | owner | evidence_type check | bumps profile revision | cascade |
| `jobs` | owner | unique (owner, canonical_key) | availability: unknown/last_observed/closed | cascade to all job children |
| `job_snapshots` | owner | unique (job, content_hash), (job, version) | immutable captured text + untrusted JSON-LD | cascade |
| `job_analyses` | owner | — | immutable; prompt/schema/taxonomy/model recorded | cascade |
| `job_corrections` | owner | — | superseded_at keeps history; originals untouched | cascade |
| `resumes` / `resume_versions` | owner | one default per owner (partial unique index); unique (resume, version) | versions immutable; `reviewed` stored separately from `extracted` | files removed on delete |
| `match_reports` | owner | — | stores exact inputs; stale computed on read | cascade |
| `interview_sessions/questions/answers` | owner | unique (session, ord), (question, revision) | answer revisions kept | cascade |
| `roadmaps/tasks/events` | owner | unique (roadmap, key) | `revision`, task `version`, event log | cascade |
| `applications` / `application_events` | owner | unique (owner, job, cycle); status check | event per change, `is_correction` flag | cascade |
| `notes` | owner | — | `version` | cascade |
| `reminders` / `notifications` | owner | notifications.reminder_id unique (idempotent delivery) | status scheduled/processed/cancelled | cascade |
| `knowledge_sources/versions/chunks` | shared (owner null) or private (owner) — check constraint | unique (source, checksum), (version, ord) | active_version pointer; review_state separate from processing status | soft delete (shared), cascade (private) |
| `operations` | owner (or system) | unique (owner, kind, idempotency_key) | attempt, lease, fence | cascade |
| `audit_events` | content-free | — | — | retained (no PII beyond user id; nulled on deletion record) |
| `deletion_jobs` | system | unique subject hash | — | — |

Time: all instants `timestamptz` (UTC); date-only deadlines kept as `date` (`reminders.due_date`) with the IANA zone. Pagination: keyset `(updated_at, id)`.

## Retention
| Data | Retention |
|---|---|
| Account data, resumes, snapshots, analyses, reports | until the user deletes them or the account |
| Uploaded files | removed with their version/resume/account (account: durable `deletion_jobs`) |
| Operation payloads/results | kept with the account (ids only, no raw resume text in payloads) |
| Temp files (`data/tmp`) | 1 hour; exports 24 h (`ELEVATE_EXPORT_RETENTION_HOURS`) |
| Logs | stdout only; no bodies/tokens/resume text; rotation is the operator's responsibility |
| Backups | operator-managed in `backups/`; see DEPLOYMENT.md for restore + re-deletion procedure |

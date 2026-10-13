# Architecture

```
 Browser extension (MV3)            Web dashboard (Next.js 16)
  popup / side panel                 pages + /api/session/* + /api/proxy/*
  service worker ── Bearer ──┐       (HttpOnly cookies; tokens never reach page JS)
                             ▼                 │ Bearer (server-side)
                       FastAPI API  ◄──────────┘
                (auth, ownership, business rules,
                 validation, matching, scheduling)
                     │            │
         PostgreSQL 17 + pgvector  private file dir (data/users/<id>/)
         (RLS, operations queue)   resumes, never web-served
                     ▲
                     │ claim (SKIP LOCKED) / lease / fenced commit
                 Worker process ── Ollama (127.0.0.1:11434, trusted operator config)
                 (analysis, parsing, embeddings, interviews, reminders, cleanup)
```

## Components and write ownership
| Component | Owns writes to | Notes |
|---|---|---|
| `services/api` (FastAPI, `elevate.main`) | every user table, synchronously | single authority for auth, ownership, scoring, transitions |
| `elevate.worker` (same package) | operation results: analyses, parsed resume text, interview questions/evaluations, knowledge chunks, notifications, deletion cleanup | only via fenced `commit_result` |
| `apps/web` | nothing in the DB; HttpOnly cookies only | thin proxy + UI; no business rules |
| `apps/extension` | `chrome.storage` (tokens, recovery records) | talks only to the API from its service worker |
| Alembic (`services/api/migrations`) | schema | the only migration authority; runs as `elevate_owner` |

The worker shares domain code with the API (one Python package), so there is one implementation of each rule.

## Request flow: capture → analysis → dashboard
1. Extension (or manual form) `POST /api/v1/jobs/capture` with an `Idempotency-Key`.
2. API validates size/URL, normalises text, upserts the per-owner `jobs` row (unique `owner_id, canonical_key`), adds an immutable `job_snapshots` row (unique per content hash), and either returns a cached complete analysis (same snapshot + prompt/schema/taxonomy/model versions) with 200, or persists an `operations` row and returns **202** + `status_url`.
3. Worker claims the operation (`FOR UPDATE SKIP LOCKED`), heartbeats a lease, runs `job_analysis.analyze` (rules → Ollama structured output → quote validation → deterministic requirement semantics) **outside any DB transaction**, then commits `job_analyses` + the terminal operation state in one transaction guarded by `(lease_owner, attempt)`.
4. Clients poll the operation (real `stage` values) and then open `/jobs/{id}`.

## Durable operations
States: `queued → running → succeeded | partially_succeeded | failed | timed_out | cancelled`, with `cancellation_requested` while running. Expired leases are re-claimed (attempt+1, capped by `max_attempts`); stale attempts cannot write (fencing). Retryable errors back off exponentially (10 s × 2ⁿ, ≤ 5 min). Deadlines → `timed_out`. Cancellation is cooperative: checked before inference and before commit; an in-flight Ollama call cannot be interrupted, which the API reports honestly.

## Authentication
First-party (see DECISIONS D-03). Argon2id passwords; 15-minute HS256 access JWTs validated for signature/iss/aud/exp/alg and the user's `token_version` (bumped on logout-all, password change, deletion ⇒ immediate revocation); 30-day opaque refresh tokens stored as SHA-256 hashes, single-use with rotation and family revocation on reuse.
* Web: Next route handlers keep tokens in HttpOnly cookies, proxy API calls server-side, require same-origin `Origin` + `X-Elevate-CSRF` for mutations.
* Extension: the signed-in dashboard page `/extension/connect` obtains an extension-scoped refresh token (`POST /auth/extension-grant`) and hands it to the extension through `chrome.runtime.sendMessage` (`externally_connectable` restricted to the dashboard origin). The service worker exchanges/rotates it.

## Authorization and isolation
Every query filters by the authenticated owner. Additionally every user-owned table has PostgreSQL RLS keyed on a transaction-local `app.user_id` that the session applies at the start of **every** transaction (`after_begin`), using a non-superuser `elevate_app` role without BYPASSRLS. System work (worker claims, scheduler, shared knowledge) sets `app.system='on'` explicitly. Integration tests run through the real runtime role.

## AI orchestration
* Provider interface `LLMProvider` (`generate_json`, `embed`, `health`); `OllamaProvider` with a process-wide concurrency semaphore; endpoint/model only from server config.
* Structured outputs use JSON schemas; outputs are re-validated with Pydantic and **semantically** (quotes must exist in the source; numbers/skills in resume suggestions must already exist; interview evaluation quotes must exist in the answer; citations must reference supplied passages and contain the excerpt).
* Deterministic code owns scoring, alternatives/thresholds, scheduling, transitions.
* Inference outage: capture still saves the job and produces a labelled partial (rules-only) analysis; all non-AI features keep working.

## Retrieval
Shared (admin-curated) and private (owner) sources share tables but retrieval authorises **inside SQL** (visibility/owner/active version/not deleted/not rejected/language/embedding model). Exact cosine search + Postgres full-text; a distance ceiling (`ELEVATE_RAG_MAX_DISTANCE`) yields an explicit "insufficient evidence" result instead of padding. Versions activate atomically (chunks inserted, then source pointer flipped in one transaction; old chunks removed).

## Reports, staleness and caching
Analyses, match reports and roadmaps are append-only/historical. Each match report stores its exact inputs (analysis id, resume version + review timestamp, profile revision, corrections revision, taxonomy and scoring versions); a report is *stale* when any differ, and identical inputs return the existing report instead of recomputing.

## Scheduler
Inside the worker every 30 s: due reminders → notifications (idempotent via unique `reminder_id`), deletion-job file cleanup, export/tmp retention.

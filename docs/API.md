# API

* Contract: generated from the implementation — `GET http://127.0.0.1:8000/api/v1/openapi.json` (docs UI at `/api/docs` outside production). A snapshot lives in `packages/api-client/openapi.json`; TS types in `packages/api-client/src/schema.ts` (`npm run gen:api` with the API running). Contract drift check: regenerate and `git diff --exit-code packages/api-client`.
* Auth: `Authorization: Bearer <access token>` on everything except `/auth/register|login|refresh|logout` and `/health/*`.
* Errors (all non-2xx):
  ```json
  {"error": {"code": "validation_failed", "message": "Some fields are invalid.", "request_id": "…",
             "retryable": false, "fields": {"text": "Too short"}}}
  ```
  Common codes: `unauthenticated`, `token_expired`, `session_revoked`, `invalid_credentials`, `not_found` (also used for other users' objects), `validation_failed`, `conflict`, `stale_write`, `idempotency_conflict`, `correction_required`, `rate_limited`/`queue_full` (+`Retry-After`), `capability_unavailable`/`model_unavailable`, `database_unavailable`, `internal_error`.
* Idempotency: optional `Idempotency-Key` (≤120 chars) on asynchronous creators; scoped per user + operation kind and bound to a payload hash (`409 idempotency_conflict` on reuse with a different payload).
* Concurrency: editable resources take `expected_version` / `expected_revision` / `expected_reviewed_at` and return `409 stale_write`.

## Asynchronous operations
`202 Accepted` → `{operation_id, status_url}`. Poll `GET /api/v1/operations/{id}`:
```json
{"id": "…", "kind": "job_analysis", "state": "running", "stage": "analyzing", "attempt": 1, "max_attempts": 3,
 "cancel_requested": false, "error": null, "result": null, "terminal": false, …}
```
`POST /operations/{id}/cancel` (cooperative), `POST /operations/{id}/retry` (failed/timed_out only). Kinds: `job_analysis`, `resume_parse`, `resume_suggest`, `interview_generate`, `answer_evaluate`, `knowledge_ingest`, `job_qa`.

## Resources (all under `/api/v1`)
| Area | Endpoints |
|---|---|
| Auth | `POST auth/register`, `auth/login`, `auth/refresh`, `auth/logout`, `auth/logout-all`, `auth/extension-grant`, `auth/change-password` |
| Me / capabilities | `GET me`, `GET taxonomy/domains`, `GET taxonomy/skills?q=` |
| Profile | `GET/PUT profile`, `GET/POST profile/facts`, `DELETE profile/facts/{id}` |
| Jobs | `POST jobs/capture`, `GET jobs?saved&q&cursor&limit`, `GET jobs/lookup?url=`, `GET/PATCH/DELETE jobs/{id}`, `POST/DELETE jobs/{id}/save`, `POST jobs/{id}/reanalyze`, `GET jobs/{id}/snapshots/{sid}`, `POST jobs/{id}/corrections`, `DELETE jobs/{id}/corrections/{cid}` |
| Matching | `POST jobs/{id}/match`, `GET jobs/{id}/match/latest`, `GET jobs/{id}/match-reports`, `GET match-reports/{id}` |
| Resumes | `GET resumes`, `POST resumes/upload` (multipart), `POST resumes/text`, `GET resumes/{rid}/versions/{vid}?job_id=`, `PUT …/review`, `POST resumes/{rid}/default`, `PATCH resumes/{rid}`, `DELETE resumes/{rid}`, `DELETE …/versions/{vid}`, `GET …/file`, `GET …/export?format=md|txt`, `POST …/suggestions` |
| Interviews | `GET interviews/options?job_id=`, `POST/GET interviews`, `GET/DELETE interviews/{sid}`, `POST interviews/{sid}/questions/{qid}/answers`, `…/skip`, `POST interviews/{sid}/status` |
| Roadmaps | `POST/GET roadmaps`, `GET/PATCH/DELETE roadmaps/{id}`, `POST roadmaps/{id}/tasks`, `PATCH/DELETE roadmaps/{id}/tasks/{tid}`, `POST roadmaps/{id}/regenerate/preview`, `…/regenerate/apply` |
| Applications | `POST/GET applications`, `GET/PATCH/DELETE applications/{id}`, `GET jobs/{id}/applications` |
| Notes | `GET/POST jobs/{id}/notes`, `PATCH/DELETE notes/{id}` |
| Reminders | `POST/GET reminders`, `POST reminders/{id}/cancel`, `GET reminders/{id}/calendar.ics` |
| Notifications | `GET notifications`, `POST notifications/{id}/read`, `…/dismiss`, `POST notifications/read-all` |
| Knowledge | `POST/GET knowledge`, `DELETE knowledge/{id}`, `POST knowledge/search`, `POST jobs/{id}/ask`; admin: `POST/GET admin/knowledge`, `POST admin/knowledge/{id}/review`, `POST admin/knowledge/{id}/versions`, `DELETE admin/knowledge/{id}` |
| Account | `GET account/export`, `POST account/delete` |
| Health | `GET /health/live`, `GET /health/ready` (DB, queue depth/age, last worker heartbeat, AI availability) |

## Example
```bash
curl -s -X POST http://127.0.0.1:8000/api/v1/jobs/capture -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Idempotency-Key: $(uuidgen)" \
  -d '{"method":"manual","text":"<job text>","save":true}'
# -> 202 {"job_id":"…","snapshot_id":"…","operation_id":"…","analysis_id":null,"reused_analysis":false,…}
```

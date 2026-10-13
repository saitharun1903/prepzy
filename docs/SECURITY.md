# Security

## Trust boundaries
1. **Job pages / resumes / retrieved documents / model output** — untrusted data. Never executed, never used to choose URLs, hosts, identities or permissions. Model output is schema- and evidence-validated before persistence.
2. **Extension content context** (injected extraction function) — returns bounded text only; the service worker validates shape/size; only the SW holds tokens and calls the API (fixed build-time origin).
3. **Web page JS** — never sees access/refresh tokens (HttpOnly cookies, server-side proxy). Exception by design: the extension-connect page briefly holds an extension refresh token to hand it to the extension.
4. **API** — derives the actor only from a verified JWT; checks ownership on every object; RLS as a second layer.
5. **Worker** — system DB context for claims only; per-operation work runs under the owner's RLS context.
6. **Ollama / DB** — operator-configured, loopback-only endpoints.

## Controls implemented
| Threat | Control | Evidence |
|---|---|---|
| Broken access control / cross-user leakage | owner filters + RLS (non-superuser, NOBYPASSRLS role); RAG authorises inside SQL | `test_cross_user_isolation_api_and_rls`, `test_runtime_role_is_not_superuser…`, `test_rag_private_isolation…`, smoke cross-user checks |
| Token theft/replay | 15-min access JWT, `token_version` revocation, rotating hashed refresh tokens with family revocation on reuse | `test_auth_errors_and_refresh_rotation` |
| CSRF | API uses bearer tokens (no ambient credentials); web proxy requires same-origin `Origin` + `X-Elevate-CSRF` | web proxy code |
| XSS | React escaping; no `dangerouslySetInnerHTML` for untrusted content; API responses `nosniff` + CSP `default-src 'none'` | code review |
| SQL injection | SQLAlchemy parameters only; dynamic SQL limited to fixed identifiers | code review |
| SSRF | No server-side fetching of user URLs at all; URLs only stored after scheme validation | `test_capture…validation` (file:// rejected) |
| Malicious files | signature check, extension/content mismatch rejected, DOCX zip-bomb ratio/size/part limits, macro parts rejected, PDF page limit, encrypted PDFs rejected, generated storage names, path regex | `test_resume_upload…` |
| Prompt injection | data delimited; no tools; quotes must exist in source; numbers/skills cannot be introduced into resume suggestions; citations verified | eval case `mkt-1` (embedded "rate 100%" instruction) |
| DoS / overload | body limit 8 MB, text/upload limits, per-user active-operation cap (429 + Retry-After), auth rate limit, LLM concurrency semaphore, deadlines | config + code |
| Duplicate side effects | idempotency keys bound to payload hash; DB unique constraints | `test_idempotent_concurrent_capture` |
| Stale/zombie work | lease + fencing; deleted accounts' rows cannot be recreated (FK) | `test_worker_lease_recovery_and_fencing`, `test_export_and_deletion_prevents_recreation` |
| Secret leakage | `.env` gitignored, generated per machine, never printed; logs redact token/text/body keys | `scripts/init_env.py` |
| Admin escalation | admin only via server `ELEVATE_ADMIN_EMAILS`; not user-editable | non-admin 403 test |

## Known limitations / release risks (must be resolved before a public beta)
* **First-party auth** is adequate for the local single-machine profile but has no email verification, MFA, or self-service recovery (operator CLI only). Replace with a maintained OIDC provider (authorization code + PKCE) before public release.
* Rate limiter is **in-process** (single API instance only).
* Extension refresh token in `chrome.storage.local` is readable by any code running in the extension's trusted contexts; it is not a vault.
* HS256 shared secret: rotate by changing `ELEVATE_JWT_SECRET` (logs everyone out).
* No malware scanning of uploads; files are never executed or served inline.
* `pip-audit` / `npm audit` results: see PROJECT_STATUS.md.

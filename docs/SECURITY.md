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

## Account security (added for production)
| Control | Implementation | Evidence |
|---|---|---|
| Email verification | single-use, hashed, 48 h tokens; AI features gated when `ELEVATE_REQUIRE_VERIFIED_EMAIL=true` | `test_email_verification_single_use`, `test_verified_email_gate_for_ai` |
| Password reset by email | single-use 30 min tokens; identical response for unknown emails; a reset revokes every session | `test_password_reset_no_enumeration_and_revokes_sessions` |
| Lockout | 5 failures lock for 15 min (configurable); unknown emails are counted identically (no enumeration) | `test_lockout_after_repeated_failures` |
| Two-step verification | TOTP (pyotp, +/-1 step, replay-protected); secrets encrypted at rest (Fernet); 10 single-use hashed recovery codes; separate short-lived MFA token audience | `test_totp_two_step_login_replay_and_recovery` |
| Rate limiting | PostgreSQL fixed windows shared by all instances: per IP on auth, per account on login/MFA/reset, per user on all API calls | integration tests |
| Config safety | production guard refuses unsafe settings; config values are never echoed in errors | `test_production_guard_refuses_unsafe_config`, CI image check |
| Transport | HSTS in production; database `sslmode=require`; Ollama reachable only on the private network | blueprint + guard |
| Files | private S3 bucket, server-side authorization, generated names, no public URLs | `test_storage_rejects_path_tricks` |
| Container | non-root user (uid 10001), slim base, no dev dependencies, secrets only via environment | image smoke test |

## Known limitations / release risks (must be resolved before a public beta)
* **First-party auth** now has email verification, reset by email, lockout and optional TOTP two-step, built only from maintained libraries. It has no social login or passkeys and has not had an external security review.
* Extension refresh token in `chrome.storage.local` is readable by any code running in the extension's trusted contexts; it is not a vault.
* HS256 shared secret: rotate by changing `ELEVATE_JWT_SECRET` (logs everyone out).
* No malware scanning of uploads; files are never executed or served inline.
* `pip-audit` / `npm audit` results: see PROJECT_STATUS.md.

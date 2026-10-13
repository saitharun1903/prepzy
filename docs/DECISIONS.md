# Decisions

| ID | Decision | Alternatives considered | Why | Cost to reverse |
|---|---|---|---|---|
| D-01 | Monorepo: `apps/web`, `apps/extension`, `services/api` (API + worker in one Python package), `packages/api-client` | separate worker service/package | One implementation of domain rules; the spec's `services/worker` is the `elevate.worker` module (no empty folder created) | Low |
| D-02 | PostgreSQL 17 + pgvector in Docker (`browserelevate` compose project, port 5433, loopback) | native PG 18 already running on the host (no pgvector binaries); Supabase stack found on the host from a different project | Native PG lacked pgvector; the existing Supabase stack belongs to another project ("elevate" name) and was not touched. Compose project renamed after a name collision removed our first container | Medium (data migration) |
| D-03 | First-party auth built from maintained libraries (argon2-cffi, PyJWT); rotating opaque refresh tokens; no self-made crypto | Keycloak, Supabase Auth, Ory Kratos/Zitadel | Host is 94% disk-full and 16 GB RAM must also hold a 7B model; Keycloak/Supabase add 1–3 GB RAM and multiple containers; all would still need the same extension hand-off. Recovery uses an operator CLI (no email in the ₹0 local profile) | High for a production public beta: replace with a managed/OIDC provider (PKCE) before public release — see SECURITY.md |
| D-04 | Postgres-backed queue (operations table, SKIP LOCKED, leases, fencing) | Celery/RQ + Redis | No extra service; tested claim/lease/fence/cancel | Low |
| D-05 | LLM: existing `qwen2.5-coder:7b` (4.7 GB, Apache-2.0) via Ollama 0.35; embeddings `nomic-embed-text` (768-d, Apache-2.0, 274 MB) | qwen2.5:3b (fits 4 GB VRAM, faster) — offered, user chose not to download; larger installed models (qwen3-coder 18 GB) too big for VRAM | Reuse avoided a download on a nearly full disk. It is code-tuned, not ideal for prose extraction; measured in AI_EVALUATION.md | Low (config) |
| D-06 | Deterministic scoring `score-1`; models never alter weights | LLM-judged fit score | Reproducible, explainable, testable | Low |
| D-07 | Exact vector search, no ANN index | HNSW/IVFFlat | Corpus is tiny; filtered ANN can drop recall | Low |
| D-08 | Taxonomy as versioned JSON (`tax-2026.10.1`) loaded in code | DB reference tables | Easy review/diff; version stored on every analysis/report | Medium |
| D-09 | Job identity is per owner (no cross-user canonical sharing) | shared canonical job table | Eliminates a whole class of leakage; dedupe still per owner via requisition id / normalized URL / content hash | Medium |
| D-10 | Resume suggestions produce a *text* version; original files are immutable | editing PDF/DOCX layout | Honest; avoids implying layout edits | Low |
| D-11 | No code execution; written exercises only | sandboxed runner | Security gate in spec §12.3 not met | — |
| D-12 | Web session via Next.js route handlers + HttpOnly cookies + same-origin/CSRF header check | tokens in localStorage | Keeps credentials out of page JS | Low |

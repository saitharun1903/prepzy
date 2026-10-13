# Privacy

## Where data is processed
Everything runs on the operator's machine in the local profile:
* Database: PostgreSQL in a local Docker container bound to 127.0.0.1.
* Files: `data/users/<user-id>/` on the local disk (outside any web root).
* AI: Ollama on 127.0.0.1 (model `qwen2.5-coder:7b`, embeddings `nomic-embed-text`). **No data is sent to external AI services**; external providers are not implemented.
* The browser extension only reads the tab you explicitly click it on, only when you click.

## Data inventory
| Data | Purpose | Stored | Retention |
|---|---|---|---|
| Email, password hash, timezone | account | users | until account deletion |
| Profile (roles, domains, stage, preferences, hours) | personalisation | profiles | until edited/deleted |
| Job text you capture, page URL/title | analysis | job_snapshots | until job/account deletion |
| Resume files and extracted text | evidence comparison | private files + resume_versions | until version/account deletion |
| Interview answers | practice feedback | interview_answers | until session/account deletion |
| Notes, applications, reminders | tracking | respective tables | until deletion |
| Private knowledge documents | your own search | knowledge_* (private) | until deletion |
| Audit events | security | action names only, no content | kept; user reference removed on deletion |

Not collected: browsing history, cookies, form field values, passwords from pages, analytics, third-party telemetry.

## Consent
Onboarding asks for **processing consent** for local AI analysis. It is not training consent: there is no training on user data, and fine-tuning (not implemented) would require a separate, explicit opt-in.

## Export and deletion
* `Settings → Export data` (`GET /api/v1/account/export`): JSON with every owned record and version relationships; resume files are listed with checksums and downloadable.
* Removing a saved job ≠ deleting it ≠ deleting the account; each is explained in the UI.
* `Settings → Delete account`: immediately revokes all sessions, cancels pending operations, deletes all rows (including vectors and reports), and schedules durable removal of stored files.
* Backups taken before a deletion still contain the data until they are rotated; after any restore, re-apply deletions listed in `deletion_jobs` (see DEPLOYMENT.md).

No legal/regulatory compliance claim is made; no applicable review has been performed.

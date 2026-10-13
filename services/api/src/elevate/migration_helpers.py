"""Security DDL shared by migrations: RLS policies and least-privilege grants for elevate_app.

The runtime role is created by scripts/db_bootstrap.py (it needs a password from .env, which
does not belong in a migration). Grants are applied only if the role exists.
"""

from __future__ import annotations

from typing import Any

# (table, owner column). All are user-owned rows protected by RLS.
OWNED: list[tuple[str, str]] = [
    ("profiles", "user_id"), ("profile_facts", "owner_id"), ("jobs", "owner_id"), ("job_snapshots", "owner_id"),
    ("job_analyses", "owner_id"), ("job_corrections", "owner_id"), ("resumes", "owner_id"),
    ("resume_versions", "owner_id"), ("match_reports", "owner_id"), ("interview_sessions", "owner_id"),
    ("interview_questions", "owner_id"), ("interview_answers", "owner_id"), ("roadmaps", "owner_id"),
    ("roadmap_tasks", "owner_id"), ("roadmap_events", "owner_id"), ("applications", "owner_id"),
    ("application_events", "owner_id"), ("notes", "owner_id"), ("reminders", "owner_id"),
    ("notifications", "owner_id"), ("operations", "owner_id"),
]

SYSTEM = "current_setting('app.system', true) = 'on'"
ME = "nullif(current_setting('app.user_id', true), '')::uuid"


def apply_security(op: Any) -> None:
    for table, col in OWNED:
        op.execute(f"alter table {table} enable row level security")
        op.execute(f"create policy {table}_owner on {table} using ({SYSTEM} or {col} = {ME}) "
                   f"with check ({SYSTEM} or {col} = {ME})")
    for table in ("knowledge_sources", "knowledge_chunks"):
        op.execute(f"alter table {table} enable row level security")
        op.execute(f"create policy {table}_read on {table} for select using "
                   f"({SYSTEM} or visibility = 'shared' or owner_id = {ME})")
        op.execute(f"create policy {table}_write on {table} for all using ({SYSTEM} or owner_id = {ME}) "
                   f"with check ({SYSTEM} or (visibility = 'private' and owner_id = {ME}))")
    op.execute("alter table knowledge_versions enable row level security")
    op.execute(
        "create policy knowledge_versions_access on knowledge_versions using "
        f"({SYSTEM} or exists (select 1 from knowledge_sources s where s.id = source_id "
        f"and (s.visibility = 'shared' or s.owner_id = {ME})))")
    op.execute("""
    do $$ begin
      if exists (select 1 from pg_roles where rolname = 'elevate_app') then
        grant usage on schema public to elevate_app;
        grant select, insert, update, delete on all tables in schema public to elevate_app;
        grant usage, select on all sequences in schema public to elevate_app;
        revoke all on alembic_version from elevate_app;
      end if;
    end $$;
    """)

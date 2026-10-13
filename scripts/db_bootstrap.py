"""Create the least-privilege runtime role, then run migrations.

Run from repo root:  cd services/api && uv run python ../../scripts/db_bootstrap.py
Idempotent. Never drops data. Refuses nothing destructive because it does nothing destructive.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from sqlalchemy import create_engine, text

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "api" / "src"))
from elevate.config import get_settings  # noqa: E402


def main() -> int:
    s = get_settings()
    import os
    app_pw = os.environ.get("ELEVATE_DB_APP_PASSWORD") or _read_env("ELEVATE_DB_APP_PASSWORD")
    if not app_pw or not s.migration_database_url:
        print("Missing ELEVATE_DB_APP_PASSWORD or ELEVATE_MIGRATION_DATABASE_URL", file=sys.stderr)
        return 2
    eng = create_engine(s.migration_database_url)
    with eng.begin() as c:
        exists = c.execute(text("select 1 from pg_roles where rolname='elevate_app'")).scalar()
        # Password is passed via format() with a literal quote; role DDL can't take bind params.
        quoted = c.execute(text("select quote_literal(:p)"), {"p": app_pw}).scalar()
        if exists:
            c.execute(text(f"alter role elevate_app with login password {quoted}"))
        else:
            c.execute(text(f"create role elevate_app with login password {quoted} nosuperuser nobypassrls"))
        c.execute(text("create extension if not exists vector"))
    print("runtime role ready; running migrations")
    api_dir = Path(__file__).resolve().parents[1] / "services" / "api"
    # Same interpreter as this script: works under `uv run` locally and inside the production image.
    r = subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=api_dir)
    if r.returncode:
        return r.returncode
    # Re-apply grants for tables created by migrations (idempotent).
    with eng.begin() as c:
        c.execute(text("grant usage on schema public to elevate_app"))
        c.execute(text("grant select, insert, update, delete on all tables in schema public to elevate_app"))
        c.execute(text("grant usage, select on all sequences in schema public to elevate_app"))
        c.execute(text("revoke all on alembic_version from elevate_app"))
    print("migrations applied; grants refreshed")
    return 0


def _read_env(key: str) -> str | None:
    env = Path(__file__).resolve().parents[1] / ".env"
    if not env.exists():
        return None
    for line in env.read_text(encoding="utf-8").splitlines():
        if line.startswith(key + "="):
            return line.split("=", 1)[1]
    return None


if __name__ == "__main__":
    sys.exit(main())

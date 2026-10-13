"""Alembic environment. Uses the OWNER connection (ELEVATE_MIGRATION_DATABASE_URL); the runtime
role (elevate_app) never runs DDL."""

from __future__ import annotations

import os

from alembic import context
from sqlalchemy import create_engine, pool

from elevate.config import get_settings
from elevate.models import Base

config = context.config
target_metadata = Base.metadata


def _url() -> str:
    override = os.environ.get("ELEVATE_MIGRATION_URL_OVERRIDE")
    if override:
        return override
    s = get_settings()
    if not s.migration_database_url:
        raise RuntimeError("ELEVATE_MIGRATION_DATABASE_URL is not configured")
    return s.migration_database_url


def run_migrations_offline() -> None:
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

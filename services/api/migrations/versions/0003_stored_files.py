"""stored files (database storage backend)

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-13 20:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from elevate.migration_helpers import ME, SYSTEM

revision: str = '0003'
down_revision: Union[str, Sequence[str], None] = '0002'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('stored_files',
    sa.Column('owner_id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=40), nullable=False),
    sa.Column('data', sa.LargeBinary(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('owner_id', 'name')
    )
    op.execute("alter table stored_files enable row level security")
    op.execute(f"create policy stored_files_owner on stored_files using ({SYSTEM} or owner_id = {ME}) "
               f"with check ({SYSTEM} or owner_id = {ME})")
    op.execute("""
    do $$ begin
      if exists (select 1 from pg_roles where rolname = 'elevate_app') then
        grant select, insert, update, delete on stored_files to elevate_app;
      end if;
    end $$""")


def downgrade() -> None:
    op.drop_table('stored_files')

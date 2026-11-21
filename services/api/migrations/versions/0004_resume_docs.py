"""resume builder: saved LaTeX resume projects

Revision ID: 0004
Revises: 0003
Create Date: 2026-11-21 07:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

from elevate.migration_helpers import ME, SYSTEM

revision: str = '0004'
down_revision: Union[str, Sequence[str], None] = '0003'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table('resume_docs',
    sa.Column('id', sa.UUID(), server_default=sa.text('gen_random_uuid()'), nullable=False),
    sa.Column('owner_id', sa.UUID(), nullable=False),
    sa.Column('title', sa.String(length=120), nullable=False),
    sa.Column('template', sa.String(length=40), nullable=False),
    sa.Column('source', sa.Text(), nullable=False),
    sa.Column('job_id', sa.UUID(), nullable=True),
    sa.Column('version', sa.Integer(), server_default=sa.text('1'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['job_id'], ['jobs.id'], ondelete='SET NULL'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_resume_docs_owner_id', 'resume_docs', ['owner_id'])
    op.execute("alter table resume_docs enable row level security")
    op.execute(f"create policy resume_docs_owner on resume_docs using ({SYSTEM} or owner_id = {ME}) "
               f"with check ({SYSTEM} or owner_id = {ME})")
    op.execute("""
    do $$ begin
      if exists (select 1 from pg_roles where rolname = 'elevate_app') then
        grant select, insert, update, delete on resume_docs to elevate_app;
      end if;
    end $$""")


def downgrade() -> None:
    op.drop_table('resume_docs')

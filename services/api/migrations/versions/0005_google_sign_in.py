"""google sign-in: link a Google account (OpenID "sub") to a user

Revision ID: 0005
Revises: 0004
Create Date: 2026-11-21 15:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

revision: str = '0005'
down_revision: Union[str, Sequence[str], None] = '0004'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column('users', sa.Column('google_sub', sa.String(length=64), nullable=True))
    op.create_unique_constraint('users_google_sub_key', 'users', ['google_sub'])


def downgrade() -> None:
    op.drop_constraint('users_google_sub_key', 'users', type_='unique')
    op.drop_column('users', 'google_sub')

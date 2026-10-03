"""fab_step run notes body

Revision ID: a9d4e2c7f156
Revises: f3a9c1e5b782
Create Date: 2026-08-11 09:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


revision: str = "a9d4e2c7f156"
down_revision: Union[str, Sequence[str], None] = "f3a9c1e5b782"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "fab_step",
        sa.Column(
            "body",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default=sa.text("''"),
        ),
    )


def downgrade() -> None:
    op.drop_column("fab_step", "body")

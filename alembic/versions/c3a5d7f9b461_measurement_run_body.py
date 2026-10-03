"""measurement_run narrative body

Revision ID: c3a5d7f9b461
Revises: b9c6e3f1d247
Create Date: 2026-07-20 19:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


revision: str = "c3a5d7f9b461"
down_revision: Union[str, Sequence[str], None] = "b9c6e3f1d247"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "measurement_run",
        sa.Column(
            "body",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default=sa.text("''"),
        ),
    )


def downgrade() -> None:
    op.drop_column("measurement_run", "body")

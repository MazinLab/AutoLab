"""instrument equipment category

Revision ID: b7e4c5d2a911
Revises: d9c1a4e7b203
Create Date: 2026-07-20 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "b7e4c5d2a911"
down_revision: Union[str, Sequence[str], None] = "d9c1a4e7b203"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "instrument",
        sa.Column(
            "category",
            sa.String(),
            nullable=False,
            server_default=sa.text("''"),
        ),
    )


def downgrade() -> None:
    op.drop_column("instrument", "category")

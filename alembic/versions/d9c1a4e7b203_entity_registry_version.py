"""entity registry optimistic concurrency version

Revision ID: d9c1a4e7b203
Revises: 6c7a9e4b2d10
Create Date: 2026-07-18 23:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d9c1a4e7b203"
down_revision: Union[str, Sequence[str], None] = "6c7a9e4b2d10"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "entity_registry",
        sa.Column(
            "version",
            sa.Integer(),
            nullable=False,
            server_default=sa.text("0"),
        ),
    )


def downgrade() -> None:
    op.drop_column("entity_registry", "version")

"""Add person.slack_id for notification DMs.

Revision ID: e1b7d3f9a524
Revises: c4e7a9d2f681
Create Date: 2026-08-08
"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel

from alembic import op

revision: str = "e1b7d3f9a524"
down_revision: Union[str, Sequence[str], None] = "c4e7a9d2f681"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "person",
        sa.Column(
            "slack_id",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default=sa.text("''"),
        ),
    )


def downgrade() -> None:
    op.drop_column("person", "slack_id")

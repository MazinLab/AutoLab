"""Add design.repo_url for the code repository behind a layout.

Revision ID: a2c8e6f4d371
Revises: b3d8f1a6c942
Create Date: 2026-08-08
"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel

from alembic import op

revision: str = "a2c8e6f4d371"
down_revision: Union[str, Sequence[str], None] = "b3d8f1a6c942"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "design",
        sa.Column(
            "repo_url",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default=sa.text("''"),
        ),
    )


def downgrade() -> None:
    op.drop_column("design", "repo_url")

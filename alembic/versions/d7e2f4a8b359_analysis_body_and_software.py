"""analysis_run narrative body + software entity type

Revision ID: d7e2f4a8b359
Revises: c3a5d7f9b461
Create Date: 2026-07-20 17:10:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel
from sqlalchemy import Text
from sqlalchemy.dialects import postgresql


revision: str = "d7e2f4a8b359"
down_revision: Union[str, Sequence[str], None] = "c3a5d7f9b461"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "analysis_run",
        sa.Column(
            "body",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default=sa.text("''"),
        ),
    )
    op.create_table(
        "software",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "name", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "description", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "extra",
            sa.JSON().with_variant(
                postgresql.JSONB(astext_type=Text()), "postgresql"
            ),
            nullable=False,
        ),
        sa.Column(
            "version", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "git_commit", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "url", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.ForeignKeyConstraint(["id"], ["entity_registry.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_software_name"), "software", ["name"], unique=False
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_software_name"), table_name="software")
    op.drop_table("software")
    op.drop_column("analysis_run", "body")

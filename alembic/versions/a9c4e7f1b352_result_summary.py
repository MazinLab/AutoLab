"""result summaries: table and analysis_run.results

Revision ID: a9c4e7f1b352
Revises: d7f2b9c4e015
Create Date: 2026-09-17 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel
from sqlalchemy import Text
from sqlalchemy.dialects import postgresql


revision: str = "a9c4e7f1b352"
down_revision: Union[str, Sequence[str], None] = "d7f2b9c4e015"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _json() -> sa.types.TypeEngine:
    return sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), "postgresql")


def upgrade() -> None:
    op.create_table(
        "result_summary",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("description", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("extra", _json(), nullable=False),
        sa.Column("body", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("columns", _json(), nullable=False, server_default=sa.text("'[]'")),
        sa.ForeignKeyConstraint(["id"], ["entity_registry.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_result_summary_name"), "result_summary", ["name"], unique=False)
    op.add_column(
        "analysis_run",
        sa.Column("results", _json(), nullable=False, server_default=sa.text("'{}'")),
    )


def downgrade() -> None:
    op.drop_column("analysis_run", "results")
    op.drop_index(op.f("ix_result_summary_name"), table_name="result_summary")
    op.drop_table("result_summary")

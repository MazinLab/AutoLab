"""substrate_batch entity type

Revision ID: f6a3c9e5b028
Revises: e5f2b8d4a917
Create Date: 2026-07-20 17:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel
from sqlalchemy import Text
from sqlalchemy.dialects import postgresql


revision: str = "f6a3c9e5b028"
down_revision: Union[str, Sequence[str], None] = "e5f2b8d4a917"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "substrate_batch",
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
            "vendor", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "material", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column("diameter_mm", sa.Float(), nullable=True),
        sa.Column("thickness_um", sa.Float(), nullable=True),
        sa.Column(
            "resistivity", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "orientation", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "spec", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column("wafer_count", sa.Integer(), nullable=True),
        sa.ForeignKeyConstraint(["id"], ["entity_registry.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_substrate_batch_name"),
        "substrate_batch",
        ["name"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(
        op.f("ix_substrate_batch_name"), table_name="substrate_batch"
    )
    op.drop_table("substrate_batch")

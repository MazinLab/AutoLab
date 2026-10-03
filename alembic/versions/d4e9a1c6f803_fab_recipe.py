"""fab_recipe entity type; fab_step.fab_run_id becomes optional

Revision ID: d4e9a1c6f803
Revises: c8d1f0a37b52
Create Date: 2026-07-20 16:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel
from sqlalchemy import Text
from sqlalchemy.dialects import postgresql


revision: str = "d4e9a1c6f803"
down_revision: Union[str, Sequence[str], None] = "c8d1f0a37b52"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "fab_recipe",
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
            "body", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.ForeignKeyConstraint(["id"], ["entity_registry.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_fab_recipe_name"), "fab_recipe", ["name"], unique=False
    )
    # Steps now anchor to wafers via edges; the fab run grouping is optional.
    with op.batch_alter_table("fab_step") as batch:
        batch.alter_column(
            "fab_run_id", existing_type=sa.Uuid(), nullable=True
        )


def downgrade() -> None:
    with op.batch_alter_table("fab_step") as batch:
        batch.alter_column(
            "fab_run_id", existing_type=sa.Uuid(), nullable=False
        )
    op.drop_index(op.f("ix_fab_recipe_name"), table_name="fab_recipe")
    op.drop_table("fab_recipe")

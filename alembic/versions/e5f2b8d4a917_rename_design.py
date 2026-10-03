"""rename design_revision to design

Revision ID: e5f2b8d4a917
Revises: d4e9a1c6f803
Create Date: 2026-07-20 16:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e5f2b8d4a917"
down_revision: Union[str, Sequence[str], None] = "d4e9a1c6f803"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index(op.f("ix_design_revision_name"), table_name="design_revision")
    op.rename_table("design_revision", "design")
    op.create_index(op.f("ix_design_name"), "design", ["name"], unique=False)
    # Registry rows and accession counters key on the type string; existing
    # DSN accessions stay valid because accessions are never parsed.
    op.execute(
        sa.text(
            "UPDATE entity_registry SET entity_type = 'design' "
            "WHERE entity_type = 'design_revision'"
        )
    )
    op.execute(
        sa.text(
            "UPDATE accession_counter SET entity_type = 'design' "
            "WHERE entity_type = 'design_revision'"
        )
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_design_name"), table_name="design")
    op.rename_table("design", "design_revision")
    op.create_index(
        op.f("ix_design_revision_name"),
        "design_revision",
        ["name"],
        unique=False,
    )
    op.execute(
        sa.text(
            "UPDATE entity_registry SET entity_type = 'design_revision' "
            "WHERE entity_type = 'design'"
        )
    )
    op.execute(
        sa.text(
            "UPDATE accession_counter SET entity_type = 'design_revision' "
            "WHERE entity_type = 'design'"
        )
    )

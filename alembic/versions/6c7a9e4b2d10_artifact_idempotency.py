"""artifact idempotency

Revision ID: 6c7a9e4b2d10
Revises: 2f201cef15a3
Create Date: 2026-07-18 20:15:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


revision: str = "6c7a9e4b2d10"
down_revision: Union[str, Sequence[str], None] = "2f201cef15a3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "entity_registry",
        sa.Column(
            "source_key", sqlmodel.sql.sqltypes.AutoString(), nullable=True
        ),
    )
    op.create_index(
        op.f("ix_entity_registry_source_key"),
        "entity_registry",
        ["source_key"],
        unique=True,
    )
    op.add_column(
        "artifact",
        sa.Column(
            "schema_version",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default="",
        ),
    )


def downgrade() -> None:
    op.drop_column("artifact", "schema_version")
    op.drop_index(
        op.f("ix_entity_registry_source_key"),
        table_name="entity_registry",
    )
    op.drop_column("entity_registry", "source_key")

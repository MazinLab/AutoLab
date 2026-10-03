"""setup designer: layout columns

Revision ID: d7f2b9c4e015
Revises: c4e8a1b7d203
Create Date: 2026-09-09 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.sql.sqltypes import Text


revision: str = "d7f2b9c4e015"
down_revision: Union[str, Sequence[str], None] = "c4e8a1b7d203"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def _json_column(name: str) -> sa.Column:
    return sa.Column(
        name,
        sa.JSON().with_variant(postgresql.JSONB(astext_type=Text()), "postgresql"),
        nullable=False,
        server_default=sa.text("'{}'"),
    )


def upgrade() -> None:
    op.add_column("experiment_setup", _json_column("layout"))
    op.add_column("experiment_setup", _json_column("layout_evaluation"))
    op.add_column("instrument", _json_column("default_layout"))


def downgrade() -> None:
    op.drop_column("instrument", "default_layout")
    op.drop_column("experiment_setup", "layout_evaluation")
    op.drop_column("experiment_setup", "layout")

"""combine cooldown and run setup into experiment_setup

Revision ID: b9c6e3f1d247
Revises: a7b4d2e8c135
Create Date: 2026-07-20 19:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


revision: str = "b9c6e3f1d247"
down_revision: Union[str, Sequence[str], None] = "a7b4d2e8c135"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.drop_index(op.f("ix_cooldown_name"), table_name="cooldown")
    op.rename_table("cooldown", "experiment_setup")
    op.create_index(
        op.f("ix_experiment_setup_name"),
        "experiment_setup",
        ["name"],
        unique=False,
    )
    op.add_column(
        "experiment_setup",
        sa.Column(
            "body",
            sqlmodel.sql.sqltypes.AutoString(),
            nullable=False,
            server_default=sa.text("''"),
        ),
    )
    # Existing CD accessions stay valid; only the type string changes.
    op.execute(
        sa.text(
            "UPDATE entity_registry SET entity_type = 'experiment_setup' "
            "WHERE entity_type = 'cooldown'"
        )
    )
    op.execute(
        sa.text(
            "UPDATE accession_counter SET entity_type = 'experiment_setup' "
            "WHERE entity_type = 'cooldown'"
        )
    )


def downgrade() -> None:
    op.drop_column("experiment_setup", "body")
    op.drop_index(
        op.f("ix_experiment_setup_name"), table_name="experiment_setup"
    )
    op.rename_table("experiment_setup", "cooldown")
    op.create_index(op.f("ix_cooldown_name"), "cooldown", ["name"], unique=False)
    op.execute(
        sa.text(
            "UPDATE entity_registry SET entity_type = 'cooldown' "
            "WHERE entity_type = 'experiment_setup'"
        )
    )
    op.execute(
        sa.text(
            "UPDATE accession_counter SET entity_type = 'cooldown' "
            "WHERE entity_type = 'experiment_setup'"
        )
    )

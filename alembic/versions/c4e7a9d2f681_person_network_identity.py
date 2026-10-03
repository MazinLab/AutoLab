"""Allow multiple network login aliases per person.

Revision ID: c4e7a9d2f681
Revises: a2c8e6f4d371
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "c4e7a9d2f681"
down_revision = "a2c8e6f4d371"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "person_network_identity",
        sa.Column("login", sa.String(), nullable=False),
        sa.Column("person_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["person_id"], ["person.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("login"),
    )
    op.create_index(
        "ix_person_network_identity_person_id",
        "person_network_identity",
        ["person_id"],
    )
    op.execute(
        sa.text(
            "INSERT INTO person_network_identity (login, person_id) "
            "SELECT tailscale_login, id FROM person "
            "WHERE length(tailscale_login) > 0"
        )
    )


def downgrade() -> None:
    op.drop_index(
        "ix_person_network_identity_person_id",
        table_name="person_network_identity",
    )
    op.drop_table("person_network_identity")

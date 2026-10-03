"""Notification subscription, outbox, and dispatcher cursor tables.

Revision ID: f3a9c1e5b782
Revises: e1b7d3f9a524
Create Date: 2026-08-08
"""

from typing import Sequence, Union

import sqlalchemy as sa
import sqlmodel

from alembic import op

revision: str = "f3a9c1e5b782"
down_revision: Union[str, Sequence[str], None] = "e1b7d3f9a524"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "notification_subscription",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("person_id", sa.Uuid(), nullable=False),
        sa.Column(
            "entity_type", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "action", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column(
            "filters",
            sa.JSON().with_variant(
                sa.dialects.postgresql.JSONB(), "postgresql"
            ),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["person_id"], ["person.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notification_subscription_person_id",
        "notification_subscription",
        ["person_id"],
    )
    op.create_table(
        "notification_outbox",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("person_id", sa.Uuid(), nullable=False),
        sa.Column("text", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column(
            "status", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column(
            "last_error", sqlmodel.sql.sqltypes.AutoString(), nullable=False
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["person_id"], ["person.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_notification_outbox_person_id",
        "notification_outbox",
        ["person_id"],
    )
    op.create_index(
        "ix_notification_outbox_status", "notification_outbox", ["status"]
    )
    op.create_table(
        "notification_cursor",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_id", sa.Uuid(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("notification_cursor")
    op.drop_index(
        "ix_notification_outbox_status", table_name="notification_outbox"
    )
    op.drop_index(
        "ix_notification_outbox_person_id", table_name="notification_outbox"
    )
    op.drop_table("notification_outbox")
    op.drop_index(
        "ix_notification_subscription_person_id",
        table_name="notification_subscription",
    )
    op.drop_table("notification_subscription")

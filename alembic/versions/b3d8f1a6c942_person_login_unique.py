"""Partial unique index on person.tailscale_login.

The service-layer uniqueness check is raceable: two concurrent creates with
the same nonempty login could both pass the pre-insert SELECT and commit,
after which identity resolution silently binds the lowest UUID. The
database constraint closes the race; empty logins stay unconstrained.

Revision ID: b3d8f1a6c942
Revises: e8f5b2c7d914
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "b3d8f1a6c942"
down_revision = "e8f5b2c7d914"
branch_labels = None
depends_on = None

_WHERE = sa.text("tailscale_login != ''")


def upgrade() -> None:
    op.create_index(
        "uq_person_tailscale_login",
        "person",
        ["tailscale_login"],
        unique=True,
        postgresql_where=_WHERE,
        sqlite_where=_WHERE,
    )


def downgrade() -> None:
    op.drop_index("uq_person_tailscale_login", table_name="person")

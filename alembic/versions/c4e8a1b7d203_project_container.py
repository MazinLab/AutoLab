"""project container: status, lead, member columns, project_item

Revision ID: c4e8a1b7d203
Revises: a9d4e2c7f156
Create Date: 2026-09-09 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
import sqlmodel


revision: str = "c4e8a1b7d203"
down_revision: Union[str, Sequence[str], None] = "a9d4e2c7f156"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Work tables that gain an optional project membership column.
MEMBER_TABLES = (
    "design",
    "fab_recipe",
    "substrate_batch",
    "wafer",
    "device",
    "experiment_setup",
    "analysis_run",
    "software",
    "note",
)


def upgrade() -> None:
    # batch_alter_table so SQLite (tests) can add foreign keys; on Postgres
    # it degrades to plain ALTERs.
    with op.batch_alter_table("project") as batch:
        batch.add_column(
            sa.Column(
                "status",
                sqlmodel.sql.sqltypes.AutoString(),
                nullable=False,
                server_default=sa.text("'active'"),
            )
        )
        batch.add_column(
            sa.Column("lead_id", sa.Uuid(), nullable=True)
        )
        batch.create_index("ix_project_status", ["status"])
        batch.create_foreign_key(
            "fk_project_lead_id_entity_registry",
            "entity_registry",
            ["lead_id"],
            ["id"],
        )

    for table in MEMBER_TABLES:
        with op.batch_alter_table(table) as batch:
            batch.add_column(
                sa.Column(
                    "project_id", sa.Uuid(), nullable=True
                )
            )
            batch.create_index(f"ix_{table}_project_id", ["project_id"])
            batch.create_foreign_key(
                f"fk_{table}_project_id_project", "project", ["project_id"], ["id"]
            )

    op.create_table(
        "project_item",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("title", sqlmodel.sql.sqltypes.AutoString(), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("target_date", sa.Date(), nullable=True),
        sa.Column("done_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("done_by_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_id", sa.Uuid(), nullable=True),
        sa.ForeignKeyConstraint(["project_id"], ["project.id"]),
        sa.ForeignKeyConstraint(["done_by_id"], ["entity_registry.id"]),
        sa.ForeignKeyConstraint(["created_by_id"], ["entity_registry.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_project_item_project_kind", "project_item", ["project_id", "kind"]
    )


def downgrade() -> None:
    op.drop_index("ix_project_item_project_kind", table_name="project_item")
    op.drop_table("project_item")
    for table in reversed(MEMBER_TABLES):
        with op.batch_alter_table(table) as batch:
            batch.drop_constraint(
                f"fk_{table}_project_id_project", type_="foreignkey"
            )
            batch.drop_index(f"ix_{table}_project_id")
            batch.drop_column("project_id")
    with op.batch_alter_table("project") as batch:
        batch.drop_constraint(
            "fk_project_lead_id_entity_registry", type_="foreignkey"
        )
        batch.drop_index("ix_project_status")
        batch.drop_column("lead_id")
        batch.drop_column("status")

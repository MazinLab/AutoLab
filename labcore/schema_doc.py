from sqlalchemy.engine.interfaces import Dialect
from sqlmodel import SQLModel

from labcore.models import (
    ProjectItem,
    AccessionCounter,
    EntityRegistry,
    Event,
    NotificationCursor,
    NotificationOutbox,
    NotificationSubscription,
    ProvenanceEdge,
)
from labcore.models.entities import (
    ENTITY_TYPES,
    PersonNetworkIdentity,
    TypedEntityMixin,
)


def _render_type(column_type: object, dialect: Dialect | None) -> str:
    if dialect is not None:
        try:
            return column_type.compile(dialect=dialect)  # type: ignore[attr-defined]
        except Exception:
            pass
    return str(column_type)


def describe_tables(
    dialect: Dialect | None = None,
) -> dict[str, dict[str, object]]:
    """Describe registered SQL tables for agents constructing catalog SQL.

    Pass the active engine's dialect so column types render as the database
    actually exposes them (UUID/JSONB/TIMESTAMPTZ on Postgres, not the
    generic SQLAlchemy names).
    """
    model_types = (
        *ENTITY_TYPES.values(),
        AccessionCounter,
        EntityRegistry,
        Event,
        ProvenanceEdge,
        PersonNetworkIdentity,
        NotificationSubscription,
        NotificationOutbox,
        NotificationCursor,
        ProjectItem,
    )
    docstrings: dict[str, str] = {}
    for model_type in model_types:
        table_doc = model_type.__doc__ or ""
        if model_type in ENTITY_TYPES.values():
            table_doc = f"{table_doc}\n\n{TypedEntityMixin.__doc__ or ''}"
        docstrings[model_type.__tablename__] = table_doc.strip()
    return {
        table.name: {
            "doc": docstrings.get(table.name, ""),
            "columns": [
                {
                    "name": column.name,
                    "type": _render_type(column.type, dialect),
                    "nullable": column.nullable,
                    "foreign_keys": sorted(
                        foreign_key.target_fullname
                        for foreign_key in column.foreign_keys
                    ),
                }
                for column in table.columns
            ],
        }
        for table in SQLModel.metadata.sorted_tables
    }

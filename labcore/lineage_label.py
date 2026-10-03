from __future__ import annotations

import uuid

from sqlmodel import Session, select

from labcore.models.base import EntityRegistry
from labcore.models.edges import ProvenanceEdge, RelationType
from labcore.service import get_entity

_MAX_LINEAGE_DEPTH = 32


def _label_token(entity: dict) -> str:
    name = entity["name"]
    if (
        1 <= len(name) <= 12
        and "." not in name
        and not any(character.isspace() for character in name)
    ):
        return name
    return str(entity["accession"])


def _primary_parent_id(session: Session, entity_id: uuid.UUID) -> uuid.UUID | None:
    return session.exec(
        select(ProvenanceEdge.dst_id)
        .join(EntityRegistry, EntityRegistry.id == ProvenanceEdge.dst_id)
        .where(
            ProvenanceEdge.src_id == entity_id,
            ProvenanceEdge.relation == str(RelationType.DERIVED_FROM),
        )
        .order_by(ProvenanceEdge.created_at, EntityRegistry.accession)
        .limit(1)
    ).first()


def lineage_label(session: Session, entity_id: uuid.UUID) -> str:
    """Derive a display label from the entity's primary ancestry chain."""
    entity = get_entity(session, entity_id)
    if entity is None:
        raise ValueError(f"unknown entity: {entity_id}")

    entities = [entity]
    seen_ids = {entity_id}
    current_id = entity_id

    for _ in range(_MAX_LINEAGE_DEPTH):
        parent_id = _primary_parent_id(session, current_id)
        if parent_id is None or parent_id in seen_ids:
            break

        parent = get_entity(session, parent_id)
        if parent is None:
            raise ValueError(f"unknown entity: {parent_id}")
        entities.append(parent)
        seen_ids.add(parent_id)
        current_id = parent_id

    return ".".join(_label_token(item) for item in reversed(entities))

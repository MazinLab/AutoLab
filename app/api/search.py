from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func
from sqlmodel import or_, select

from app.api.entities import SessionDep
from labcore.models.base import EntityRegistry
from labcore.models.entities import ENTITY_TYPES

router = APIRouter(prefix="/api")


_SNIPPET_CONTEXT = 60


def _body_snippet(body: str, q: str) -> str | None:
    """A short window around the first case-insensitive match of q in body."""
    index = body.lower().find(q.lower())
    if index < 0:
        return None
    start = max(0, index - _SNIPPET_CONTEXT)
    end = min(len(body), index + len(q) + _SNIPPET_CONTEXT)
    snippet = " ".join(body[start:end].split())
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(body) else ""
    return f"{prefix}{snippet}{suffix}"


@router.get("/search")
def search(
    q: str,
    session: SessionDep,
    limit: Annotated[int, Query(ge=0, le=100)] = 25,
) -> list[dict]:
    # Escape LIKE metacharacters so q is matched literally (q=% must not
    # match everything).
    escaped = (
        q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    )
    pattern = f"%{escaped}%"
    hits: list[dict] = []
    for entity_type, cls in ENTITY_TYPES.items():
        name = getattr(cls, "name")
        description = getattr(cls, "description")
        # Narrative bodies (notes, logs, recipes, analyses) are the ELN's
        # substance; a search that can't see them fails its core promise.
        body = getattr(cls, "body", None)
        conditions = [
            name.ilike(pattern, escape="\\"),
            description.ilike(pattern, escape="\\"),
            # accession match makes typed [[W-2026-0001]] references
            # resolvable through the same search endpoint
            EntityRegistry.accession.ilike(pattern, escape="\\"),
        ]
        if body is not None:
            conditions.append(body.ilike(pattern, escape="\\"))
        rows = session.exec(
            select(cls, EntityRegistry)
            .join(EntityRegistry, EntityRegistry.id == cls.id)
            .where(or_(*conditions))
            .order_by(func.lower(name), EntityRegistry.accession)
            .limit(limit)
        ).all()
        hits.extend(
            {
                "id": row.id,
                "entity_type": entity_type,
                "accession": reg.accession,
                "name": row.name,
                "snippet": (
                    _body_snippet(row.body, q)
                    if body is not None and row.body
                    else None
                ),
            }
            for row, reg in rows
        )
    # Deterministic global ordering before truncation — otherwise results
    # depend on ENTITY_TYPES dict order and earlier types crowd out later ones.
    hits.sort(key=lambda h: (h["name"].lower(), h["accession"]))
    return hits[:limit]

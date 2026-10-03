from __future__ import annotations

import uuid

from fastmcp import FastMCP
from sqlalchemy.engine import Engine
from sqlmodel import Session

from labcore.lineage import add_edge
from labcore.models.edges import RelationType
from labcore.service import (
    create_entity,
    resolve_registry,
    update_entity,
)


def _require_agent(session: Session, agent_id: str) -> uuid.UUID:
    """MCP writes are agent-attributed by construction.

    Humans write through the PWA; an LLM writing here must name its own
    registered agent entity so every record it creates is attributable.
    """
    try:
        parsed = uuid.UUID(agent_id)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("agent_id must be a UUID") from exc
    agent = resolve_registry(session, parsed)
    if agent is None or agent.entity_type != "agent":
        raise ValueError("agent_id must reference a registered agent")
    return parsed


def register_write_tools(mcp: FastMCP, engine: Engine) -> None:
    """Catalog write tools for LLM agents: create, update, link.

    Deliberately no delete — destructive corrections stay a human decision
    in the PWA. An automated analyzer can create an analysis_run, upload-free
    register results it wrote to the store, link provenance, and amend its
    own records, which covers the analysis-automation loop.
    """

    @mcp.tool
    def create_record(
        entity_type: str,
        data: dict,
        agent_id: str,
        links: list[dict] | None = None,
        source_key: str | None = None,
    ) -> dict:
        """Create a catalog record, optionally with outbound provenance links.

        links: [{"relation": ..., "dst_id" | "dst_accession": ...}] applied in
        the same transaction — a bad link rolls back the record. source_key
        makes the create idempotent across retries.
        """
        with Session(engine) as session:
            actor_id = _require_agent(session, agent_id)
            record = create_entity(
                session,
                entity_type,
                data,
                actor_id=actor_id,
                source_key=source_key,
                links=links,
            )
            session.commit()
            return record

    @mcp.tool
    def update_record(entity_id: str, patch: dict, agent_id: str) -> dict:
        """Patch fields on an existing record (identity fields excluded)."""
        try:
            parsed_id = uuid.UUID(entity_id)
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError("entity_id must be a UUID") from exc
        with Session(engine) as session:
            actor_id = _require_agent(session, agent_id)
            updated = update_entity(
                session, parsed_id, patch, actor_id=actor_id
            )
            if updated is None:
                raise ValueError(f"unknown entity: {parsed_id}")
            session.commit()
            return updated

    @mcp.tool
    def link_records(
        src_id: str, relation: str, dst_id: str, agent_id: str
    ) -> dict:
        """Create one provenance edge (src RELATION dst). Idempotent."""
        try:
            relation_type = RelationType(relation)
        except ValueError as exc:
            raise ValueError(f"unknown relation: {relation!r}") from exc
        try:
            parsed_src = uuid.UUID(src_id)
            parsed_dst = uuid.UUID(dst_id)
        except (AttributeError, TypeError, ValueError) as exc:
            raise ValueError("src_id and dst_id must be UUIDs") from exc
        with Session(engine) as session:
            actor_id = _require_agent(session, agent_id)
            edge = add_edge(
                session,
                parsed_src,
                relation_type,
                parsed_dst,
                actor_id=actor_id,
            )
            session.commit()
            return {
                "id": str(edge.id),
                "src_id": str(edge.src_id),
                "relation": edge.relation,
                "dst_id": str(edge.dst_id),
            }

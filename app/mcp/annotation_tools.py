from __future__ import annotations

import uuid

from fastmcp import FastMCP
from sqlalchemy.engine import Engine
from sqlmodel import Session

from labcore.lineage import add_edge
from labcore.models.edges import RelationType
from labcore.service import create_entity, resolve_registry


def _parse_entity_id(value: str, field_name: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be a UUID") from exc


def register_annotation_tools(mcp: FastMCP, engine: Engine) -> None:
    """Register the agent-only annotation proposal tool."""

    @mcp.tool
    def propose_annotation(
        entity_id: str,
        text: str,
        agent_id: str,
        evidence_ids: list[str] | None = None,
    ) -> dict:
        """File an agent-attributed review task with supporting evidence."""
        parsed_agent_id = _parse_entity_id(agent_id, "agent_id")

        with Session(engine) as session:
            agent = resolve_registry(session, parsed_agent_id)
            if agent is None or agent.entity_type != "agent":
                raise ValueError("agent_id must reference a registered agent")

            parsed_entity_id = _parse_entity_id(entity_id, "entity_id")
            if resolve_registry(session, parsed_entity_id) is None:
                raise ValueError(f"unregistered entity: {parsed_entity_id}")

            parsed_evidence_ids: list[uuid.UUID] = []
            for evidence_id in evidence_ids or []:
                parsed_evidence_id = _parse_entity_id(evidence_id, "evidence_id")
                if resolve_registry(session, parsed_evidence_id) is None:
                    raise ValueError(f"unregistered entity: {parsed_evidence_id}")
                parsed_evidence_ids.append(parsed_evidence_id)

            review_task = create_entity(
                session,
                "review_task",
                {
                    "name": f"annotation: {text[:60]}",
                    "description": text,
                },
                actor_id=parsed_agent_id,
            )
            # The target gets a distinct relation from the evidence, so the
            # catalog can always recover WHICH entity the annotation concerns.
            add_edge(
                session,
                review_task["id"],
                RelationType.ANNOTATES,
                parsed_entity_id,
                actor_id=parsed_agent_id,
            )
            for evidence_ref in parsed_evidence_ids:
                add_edge(
                    session,
                    review_task["id"],
                    RelationType.REFERS_TO,
                    evidence_ref,
                    actor_id=parsed_agent_id,
                )
            session.commit()
            return review_task

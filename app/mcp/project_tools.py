"""Project report and checklist tools for LLM agents."""

import uuid

from fastmcp import FastMCP
from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.mcp.write_tools import _require_agent
from labcore.projects import create_item, project_report, update_item


def _parse_uuid(value: str, field_name: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except ValueError as exc:
        raise ValueError(f"{field_name} must be a UUID") from exc


def register_project_tools(mcp: FastMCP, engine: Engine) -> None:
    @mcp.tool
    def get_project_report(project_id: str) -> dict:
        """Progress report for one project: status, lead, goals, milestones,
        progress counts, work grouped by type, and recent events."""
        with Session(engine) as session:
            return project_report(session, _parse_uuid(project_id, "project_id"))

    @mcp.tool
    def create_project_item(
        project_id: str,
        agent_id: str,
        kind: str,
        title: str,
        target_date: str | None = None,
    ) -> dict:
        """Add a goal or milestone (kind "goal" | "milestone") to a project.
        target_date (ISO date) is allowed on milestones only."""
        with Session(engine) as session:
            actor_id = _require_agent(session, agent_id)
            item = create_item(
                session,
                _parse_uuid(project_id, "project_id"),
                kind,
                title,
                target_date=target_date,
                actor_id=actor_id,
            )
            session.commit()
            return item

    @mcp.tool
    def update_project_item(item_id: str, agent_id: str, patch: dict) -> dict:
        """Patch a goal or milestone. Keys: title, target_date, done. An
        absent key is preserved; target_date null clears the date; done
        true/false marks done or reopens (idempotent)."""
        with Session(engine) as session:
            actor_id = _require_agent(session, agent_id)
            item = update_item(
                session, _parse_uuid(item_id, "item_id"), patch, actor_id=actor_id
            )
            session.commit()
            return item

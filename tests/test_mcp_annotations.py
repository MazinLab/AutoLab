from __future__ import annotations

import asyncio
import uuid

import pytest
from fastmcp import Client
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.mcp.server import create_mcp
from labcore.events import list_events
from labcore.models.base import EntityRegistry
from labcore.models.edges import ProvenanceEdge, RelationType
from labcore.service import create_entity


def _propose_annotation(engine: Engine, arguments: dict[str, object]) -> dict:
    async def call_tool() -> dict:
        async with Client(create_mcp(engine, Settings())) as client:
            return (await client.call_tool("propose_annotation", arguments)).data

    return asyncio.run(call_tool())


def test_propose_annotation_attributes_task_edges_and_events(
    engine: Engine,
) -> None:
    with Session(engine) as session:
        agent = create_entity(session, "agent", {"name": "claude"})
        device = create_entity(session, "device", {"name": "device 7"})
        evidence = create_entity(session, "artifact", {"name": "IQ sweep"})
        session.commit()

    text = "Qi degraded after cooldown 3; suspect aging across repeated thermal cycles."
    task = _propose_annotation(
        engine,
        {
            "entity_id": str(device["id"]),
            "text": text,
            "agent_id": str(agent["id"]),
            "evidence_ids": [str(evidence["id"])],
        },
    )
    task_id = uuid.UUID(str(task["id"]))

    with Session(engine) as session:
        registry = session.get(EntityRegistry, task_id)
        assert registry is not None
        assert registry.entity_type == "review_task"
        assert registry.created_by_id == agent["id"]
        assert task["name"] == f"annotation: {text[:60]}"
        assert task["description"] == text

        # the target carries a distinct relation from the evidence, so the
        # catalog can recover which entity the annotation concerns
        annotates = session.exec(
            select(ProvenanceEdge).where(
                ProvenanceEdge.src_id == task_id,
                ProvenanceEdge.relation == str(RelationType.ANNOTATES),
            )
        ).all()
        assert {edge.dst_id for edge in annotates} == {device["id"]}
        refers = session.exec(
            select(ProvenanceEdge).where(
                ProvenanceEdge.src_id == task_id,
                ProvenanceEdge.relation == str(RelationType.REFERS_TO),
            )
        ).all()
        assert {edge.dst_id for edge in refers} == {evidence["id"]}

        task_events = [
            event
            for event in list_events(session, limit=1000)
            if event["entity_id"] == task_id
        ]
        assert [event["action"] for event in task_events] == [
            "created",
            "linked",
            "linked",
        ]
        assert all(event["actor_id"] == agent["id"] for event in task_events)


def test_propose_annotation_rejects_person_actor(engine: Engine) -> None:
    with Session(engine) as session:
        person = create_entity(session, "person", {"name": "Ben"})
        device = create_entity(session, "device", {"name": "device 7"})
        session.commit()

    with pytest.raises(Exception, match="registered agent"):
        _propose_annotation(
            engine,
            {
                "entity_id": str(device["id"]),
                "text": "should fail",
                "agent_id": str(person["id"]),
            },
        )

    with Session(engine) as session:
        review_tasks = session.exec(
            select(EntityRegistry).where(EntityRegistry.entity_type == "review_task")
        ).all()
        assert review_tasks == []


def test_propose_annotation_rejects_unregistered_evidence(
    engine: Engine,
) -> None:
    with Session(engine) as session:
        agent = create_entity(session, "agent", {"name": "claude"})
        device = create_entity(session, "device", {"name": "device 7"})
        session.commit()

    unknown_evidence_id = uuid.uuid4()
    with pytest.raises(Exception, match=f"unregistered entity: {unknown_evidence_id}"):
        _propose_annotation(
            engine,
            {
                "entity_id": str(device["id"]),
                "text": "should fail",
                "agent_id": str(agent["id"]),
                "evidence_ids": [str(unknown_evidence_id)],
            },
        )

    with Session(engine) as session:
        review_tasks = session.exec(
            select(EntityRegistry).where(EntityRegistry.entity_type == "review_task")
        ).all()
        assert review_tasks == []
        assert len(list_events(session, limit=1000)) == 2


def test_propose_annotation_rejects_unregistered_target(
    engine: Engine,
) -> None:
    with Session(engine) as session:
        agent = create_entity(session, "agent", {"name": "claude"})
        session.commit()

    unknown_entity_id = uuid.uuid4()
    with pytest.raises(Exception, match=f"unregistered entity: {unknown_entity_id}"):
        _propose_annotation(
            engine,
            {
                "entity_id": str(unknown_entity_id),
                "text": "should fail",
                "agent_id": str(agent["id"]),
            },
        )

    with Session(engine) as session:
        review_tasks = session.exec(
            select(EntityRegistry).where(EntityRegistry.entity_type == "review_task")
        ).all()
        assert review_tasks == []

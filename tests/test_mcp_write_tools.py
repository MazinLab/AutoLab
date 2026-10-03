from __future__ import annotations

import asyncio
import uuid

import pytest
from fastmcp import Client
from fastmcp.exceptions import ToolError
from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.config import Settings
from app.mcp.server import create_mcp
from labcore.lineage import lineage
from labcore.service import create_entity, get_entity


def _call(engine: Engine, tool: str, arguments: dict[str, object]) -> dict:
    async def call_tool() -> dict:
        async with Client(create_mcp(engine, Settings())) as client:
            return (await client.call_tool(tool, arguments)).data

    return asyncio.run(call_tool())


@pytest.fixture()
def agent(engine: Engine) -> dict:
    with Session(engine) as session:
        created = create_entity(session, "agent", {"name": "analyzer"})
        session.commit()
    return created


def test_create_record_with_links_is_agent_attributed(
    engine: Engine, agent: dict
) -> None:
    with Session(engine) as session:
        note = create_entity(
            session, "note", {"name": "cooldown 41", "template": "Experiment"}
        )
        session.commit()

    record = _call(
        engine,
        "create_record",
        {
            "entity_type": "analysis_run",
            "data": {"name": "Qi fits", "body": "18/18 resonators fit."},
            "agent_id": str(agent["id"]),
            "links": [
                {"relation": "derived_from", "dst_id": str(note["id"])}
            ],
        },
    )

    assert record["accession"].startswith("AR-")
    assert record["created_by_id"] == str(agent["id"])
    with Session(engine) as session:
        ancestors = lineage(
            session, uuid.UUID(str(record["id"])), direction="up"
        )
        assert [node["id"] for node in ancestors] == [note["id"]]


def test_create_record_requires_a_registered_agent(engine: Engine) -> None:
    with Session(engine) as session:
        person = create_entity(session, "person", {"name": "Alice"})
        session.commit()

    with pytest.raises(ToolError, match="registered agent"):
        _call(
            engine,
            "create_record",
            {
                "entity_type": "note",
                "data": {"name": "n"},
                "agent_id": str(person["id"]),
            },
        )


def test_update_record(engine: Engine, agent: dict) -> None:
    with Session(engine) as session:
        run = create_entity(session, "analysis_run", {"name": "fits"})
        session.commit()

    updated = _call(
        engine,
        "update_record",
        {
            "entity_id": str(run["id"]),
            "patch": {"body": "revised: 17/18."},
            "agent_id": str(agent["id"]),
        },
    )

    assert updated["body"] == "revised: 17/18."
    with Session(engine) as session:
        stored = get_entity(session, uuid.UUID(str(run["id"])))
        assert stored is not None
        assert stored["body"] == "revised: 17/18."


def test_link_records(engine: Engine, agent: dict) -> None:
    with Session(engine) as session:
        software = create_entity(session, "software", {"name": "mkidanalysis"})
        run = create_entity(session, "analysis_run", {"name": "fits"})
        session.commit()

    edge = _call(
        engine,
        "link_records",
        {
            "src_id": str(run["id"]),
            "relation": "refers_to",
            "dst_id": str(software["id"]),
            "agent_id": str(agent["id"]),
        },
    )

    assert edge["relation"] == "refers_to"
    assert edge["src_id"] == str(run["id"])


def test_project_tools_create_patch_and_report(engine: Engine, agent: dict) -> None:
    with Session(engine) as session:
        project = create_entity(session, "project", {"name": "P"})
        session.commit()
    item = _call(
        engine,
        "create_project_item",
        {
            "project_id": project["id"],
            "agent_id": agent["id"],
            "kind": "milestone",
            "title": "M",
            "target_date": "2026-12-01",
        },
    )
    assert item["kind"] == "milestone"
    patched = _call(
        engine,
        "update_project_item",
        {"item_id": item["id"], "agent_id": agent["id"], "patch": {"done": True}},
    )
    assert patched["done_at"] is not None
    assert str(patched["target_date"]).startswith("2026-12-01")
    report = _call(engine, "get_project_report", {"project_id": project["id"]})
    assert report["progress"]["milestones_done"] == 1
    with pytest.raises(ToolError):
        _call(engine, "get_project_report", {"project_id": str(uuid.uuid4())})


def test_rf_tools_return_parts_and_setup_evaluation(engine: Engine) -> None:
    from tests.test_rfchain import EXAMPLE

    with Session(engine) as session:
        setup = create_entity(session, "experiment_setup", {"name": "CD", "layout": EXAMPLE})
        session.commit()
    parts = _call(engine, "get_rf_parts", {})
    assert any(p["id"] == "paramp" for p in parts["parts"])
    out = _call(engine, "evaluate_setup", {"setup_id": setup["id"]})
    assert out["evaluation"]["feedlines"]["A"]["input"]["attenuation_db"] == 60
    assert out["saved_evaluation"]["evaluator_version"] == 1
    with pytest.raises(ToolError):
        _call(engine, "evaluate_setup", {"setup_id": str(uuid.uuid4())})

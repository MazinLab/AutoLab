"""Project goals, milestones, membership events, and the report."""

from __future__ import annotations

import uuid
from datetime import date, timedelta

import pytest
from sqlmodel import Session, select

from labcore.models.events import Event
from labcore.projects import (
    ProjectItemNotFoundError,
    create_item,
    delete_item,
    list_items,
    project_report,
    reorder_items,
    set_item_done,
    update_item,
)
from labcore.service import create_entity, delete_entity, update_entity


@pytest.fixture()
def person(session: Session) -> dict:
    return create_entity(session, "person", {"name": "Ben"})


@pytest.fixture()
def project(session: Session) -> dict:
    return create_entity(session, "project", {"name": "Air Bridge MKIDs"})


def _actions(session: Session, entity_id: uuid.UUID) -> list[str]:
    return [
        e.action
        for e in session.exec(
            select(Event).where(Event.entity_id == entity_id).order_by(Event.at, Event.id)
        ).all()
    ]


def test_create_item_appends_and_records_event(session: Session, project: dict) -> None:
    first = create_item(session, project["id"], "goal", "  Demonstrate air bridges ")
    second = create_item(session, project["id"], "goal", "Publish")
    assert first["title"] == "Demonstrate air bridges"
    assert (first["position"], second["position"]) == (0, 1)
    assert _actions(session, project["id"])[-2:] == [
        "project_item.created",
        "project_item.created",
    ]
    listed = list_items(session, project["id"])
    assert [g["title"] for g in listed["goals"]] == ["Demonstrate air bridges", "Publish"]
    assert listed["milestones"] == []


def test_goal_rejects_target_date_and_empty_title(session: Session, project: dict) -> None:
    with pytest.raises(ValueError, match="target date"):
        create_item(session, project["id"], "goal", "G", target_date="2026-10-01")
    with pytest.raises(ValueError, match="title"):
        create_item(session, project["id"], "milestone", "   ")
    with pytest.raises(ValueError, match="kind"):
        create_item(session, project["id"], "task", "T")


def test_done_and_reopen_record_actor_and_are_idempotent(
    session: Session, project: dict, person: dict
) -> None:
    item = create_item(session, project["id"], "milestone", "First wafer out")
    done = set_item_done(session, item["id"], True, actor_id=person["id"])
    assert done["done_by_id"] == person["id"]
    assert done["done_at"] is not None
    again = set_item_done(session, item["id"], True)
    assert again["done_at"] == done["done_at"]
    assert again["done_by_id"] == person["id"]
    reopened = set_item_done(session, item["id"], False)
    assert reopened["done_at"] is None and reopened["done_by_id"] is None
    set_item_done(session, item["id"], False)
    assert _actions(session, project["id"])[-3:] == [
        "project_item.created",
        "project_item.done",
        "project_item.reopened",
    ]


def test_update_patch_preserves_omitted_fields_and_null_clears(
    session: Session, project: dict
) -> None:
    item = create_item(
        session, project["id"], "milestone", "Cooldown", target_date="2026-11-01"
    )
    patched = update_item(session, item["id"], {"done": True})
    assert patched["target_date"] == date(2026, 11, 1)
    cleared = update_item(session, item["id"], {"target_date": None, "title": "Cooldown 2"})
    assert cleared["target_date"] is None and cleared["title"] == "Cooldown 2"
    with pytest.raises(ValueError, match="unknown item fields"):
        update_item(session, item["id"], {"position": 3})


def test_reorder_requires_the_full_set_once(session: Session, project: dict) -> None:
    a = create_item(session, project["id"], "milestone", "A")
    b = create_item(session, project["id"], "milestone", "B")
    reordered = reorder_items(session, project["id"], "milestone", [b["id"], a["id"]])
    assert [i["title"] for i in reordered] == ["B", "A"]
    with pytest.raises(ValueError, match="duplicates"):
        reorder_items(session, project["id"], "milestone", [a["id"], a["id"]])
    with pytest.raises(ValueError, match="every current item"):
        reorder_items(session, project["id"], "milestone", [a["id"]])
    with pytest.raises(ValueError, match="every current item"):
        reorder_items(session, project["id"], "milestone", [a["id"], b["id"], uuid.uuid4()])


def test_delete_item_records_event_and_scopes_to_project(
    session: Session, project: dict
) -> None:
    other = create_entity(session, "project", {"name": "Other"})
    item = create_item(session, project["id"], "goal", "G")
    with pytest.raises(ProjectItemNotFoundError):
        delete_item(session, item["id"], project_id=other["id"])
    delete_item(session, item["id"], project_id=project["id"])
    assert list_items(session, project["id"])["goals"] == []
    assert _actions(session, project["id"])[-1] == "project_item.deleted"


def test_membership_validated_and_moves_recorded_on_both_projects(
    session: Session, project: dict
) -> None:
    other = create_entity(session, "project", {"name": "Other"})
    with pytest.raises(ValueError, match="project_id must reference a project"):
        create_entity(session, "wafer", {"name": "W", "project_id": uuid.uuid4()})
    wafer = create_entity(session, "wafer", {"name": "W", "project_id": project["id"]})
    assert _actions(session, project["id"])[-1] == "project.member_added"
    update_entity(session, wafer["id"], {"project_id": other["id"]})
    assert _actions(session, project["id"])[-1] == "project.member_removed"
    assert _actions(session, other["id"])[-1] == "project.member_added"
    update_entity(session, wafer["id"], {"material": "Nb"})
    assert _actions(session, other["id"])[-1] == "project.member_added"  # unchanged
    delete_entity(session, wafer["id"])
    assert _actions(session, other["id"])[-1] == "project.member_removed"


def test_project_status_and_lead_validated(session: Session, person: dict) -> None:
    with pytest.raises(ValueError, match="invalid project status"):
        create_entity(session, "project", {"name": "P", "status": "done"})
    with pytest.raises(ValueError, match="lead_id must reference a person"):
        create_entity(session, "project", {"name": "P", "lead_id": uuid.uuid4()})
    project = create_entity(
        session, "project", {"name": "P", "status": "on_hold", "lead_id": person["id"]}
    )
    assert project["status"] == "on_hold" and project["lead_id"] == person["id"]


def test_delete_project_refused_with_work_and_cascades_items(
    session: Session, project: dict
) -> None:
    create_item(session, project["id"], "goal", "G")
    wafer = create_entity(session, "wafer", {"name": "W", "project_id": project["id"]})
    with pytest.raises(ValueError, match="still contains 1 records"):
        delete_entity(session, project["id"])
    delete_entity(session, wafer["id"])
    delete_entity(session, project["id"])
    assert session.exec(select(Event).where(Event.action == "deleted")).all()
    from labcore.models.project_items import ProjectItem

    assert session.exec(select(ProjectItem)).all() == []


def test_report_counts_direct_and_indirect_work(
    session: Session, project: dict, person: dict
) -> None:
    wafer = create_entity(session, "wafer", {"name": "W", "project_id": project["id"]})
    other_wafer = create_entity(session, "wafer", {"name": "X"})
    create_entity(session, "device", {"name": "D", "project_id": project["id"]})
    create_entity(
        session,
        "note",
        {"name": "Exp", "template": "Experiment", "project_id": project["id"]},
    )
    create_entity(
        session,
        "fab_step",
        {"step_index": 1},
        links=[{"relation": "refers_to", "dst_id": wafer["id"]}],
    )
    create_entity(
        session,
        "fab_step",
        {"step_index": 1},
        links=[{"relation": "refers_to", "dst_id": other_wafer["id"]}],
    )
    create_entity(
        session,
        "note",
        {"name": "FN", "template": "Fab Note"},
        links=[{"relation": "refers_to", "dst_id": wafer["id"]}],
    )
    create_entity(
        session,
        "measurement_run",
        {"name": "XRD"},
        links=[{"relation": "refers_to", "dst_id": wafer["id"]}],
    )
    create_item(session, project["id"], "goal", "G")
    late = create_item(
        session,
        project["id"],
        "milestone",
        "Late",
        target_date=date.today() - timedelta(days=1),
    )
    create_item(
        session,
        project["id"],
        "milestone",
        "Soon",
        target_date=date.today() + timedelta(days=30),
    )
    set_item_done(session, late["id"], True, actor_id=person["id"])
    update_entity(session, project["id"], {"lead_id": person["id"]})

    report = project_report(session, project["id"])
    counts = {key: block["count"] for key, block in report["work"].items()}
    assert counts == {
        "wafer": 1,
        "device": 1,
        "experiment_setup": 0,
        "experiment": 1,
        "analysis_run": 0,
        "design": 0,
        "fab_recipe": 0,
        "substrate_batch": 0,
        "software": 0,
        "fab_step": 1,
        "fab_note": 1,
        "measurement_run": 1,
        "result_summary": 0,
    }
    assert report["work"]["wafer"]["recent"][0]["id"] == wafer["id"]
    assert report["lead"]["id"] == person["id"]
    assert report["progress"] == {
        "goals_done": 0,
        "goals_total": 1,
        "milestones_done": 1,
        "milestones_total": 2,
        "overdue_milestones": 0,
    }
    actions = {e["action"] for e in report["events"]}
    assert {"created", "project_item.done", "project.member_added", "linked"} <= actions
    event_ids = {e["entity_id"] for e in report["events"]}
    assert other_wafer["id"] not in event_ids


def test_overdue_counts_open_past_due_milestones(session: Session, project: dict) -> None:
    create_item(
        session,
        project["id"],
        "milestone",
        "Missed",
        target_date=date.today() - timedelta(days=3),
    )
    assert project_report(session, project["id"])["progress"]["overdue_milestones"] == 1


def test_report_lists_result_summaries_that_include_project_analyses(
    session: Session, project: dict
) -> None:
    from labcore.lineage import add_edge
    from labcore.models.edges import RelationType

    other = create_entity(session, "project", {"name": "Other"})
    shared = create_entity(session, "result_summary", {"name": "TLS noise"})
    foreign = create_entity(session, "result_summary", {"name": "Not ours"})
    a1 = create_entity(session, "analysis_run", {"name": "A1", "project_id": project["id"], "results": {"q": 1}})
    a2 = create_entity(session, "analysis_run", {"name": "A2", "project_id": project["id"], "results": {"q": 2}})
    b1 = create_entity(session, "analysis_run", {"name": "B1", "project_id": other["id"], "results": {"q": 3}})
    add_edge(session, a1["id"], RelationType.REFERS_TO, shared["id"])
    add_edge(session, a2["id"], RelationType.REFERS_TO, shared["id"])
    add_edge(session, b1["id"], RelationType.REFERS_TO, foreign["id"])
    block = project_report(session, project["id"])["work"]["result_summary"]
    assert block["count"] == 1
    assert [s["name"] for s in block["recent"]] == ["TLS noise"]

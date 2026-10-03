"""Result summary table: union of keys, column overrides, cross-project rows."""

from __future__ import annotations

import uuid

import pytest
from sqlmodel import Session

from labcore.lineage import add_edge
from labcore.models.edges import RelationType
from labcore.results import summary_table
from labcore.service import create_entity


def _analysis(session: Session, project: dict, name: str, results: dict, links: list | None = None) -> dict:
    return create_entity(
        session,
        "analysis_run",
        {"name": name, "project_id": project["id"], "results": results},
        links=links or [],
    )


def _join(session: Session, analysis: dict, summary: dict) -> None:
    add_edge(session, analysis["id"], RelationType.REFERS_TO, summary["id"])


def test_keys_are_the_union_in_first_seen_order(session: Session) -> None:
    project = create_entity(session, "project", {"name": "P"})
    summary = create_entity(session, "result_summary", {"name": "TLS"})
    first = _analysis(session, project, "A1", {"t_mk": 100, "q_i": 1.0})
    second = _analysis(session, project, "A2", {"tls_hz2": 3e-17, "t_mk": 120})
    _join(session, first, summary)
    _join(session, second, summary)
    table = summary_table(session, summary["id"])
    # Sorted within a row, first seen across rows.
    assert table["keys"] == ["q_i", "t_mk", "tls_hz2"]
    assert [c["key"] for c in table["columns"]] == ["q_i", "t_mk", "tls_hz2"]
    assert all(c["label"] == c["key"] for c in table["columns"])
    assert [r["analysis"]["name"] for r in table["rows"]] == ["A1", "A2"]
    assert list(table["rows"][1]["results"].items()) == [("t_mk", 120), ("tls_hz2", 3e-17)]
    assert table["summary"]["accession"].startswith("RS-")


def test_stored_columns_override_order_labels_and_visibility(session: Session) -> None:
    project = create_entity(session, "project", {"name": "P"})
    summary = create_entity(
        session,
        "result_summary",
        {"name": "TLS", "columns": [{"key": "t_mk", "label": "T (mK)"}, {"key": "missing", "label": ""}]},
    )
    _join(session, _analysis(session, project, "A1", {"q_i": 1.0, "t_mk": 100}), summary)
    table = summary_table(session, summary["id"])
    assert table["keys"] == ["q_i", "t_mk"]
    assert table["columns"] == [{"key": "t_mk", "label": "T (mK)"}, {"key": "missing", "label": "missing"}]


def test_rows_carry_their_own_project_and_experiment(session: Session) -> None:
    alpha = create_entity(session, "project", {"name": "Alpha"})
    beta = create_entity(session, "project", {"name": "Beta"})
    experiment = create_entity(
        session, "note", {"name": "Cooldown 7", "template": "Experiment", "project_id": alpha["id"]}
    )
    summary = create_entity(session, "result_summary", {"name": "TLS"})
    a = _analysis(session, alpha, "A", {"q_i": 1}, links=[{"relation": "derived_from", "dst_id": experiment["id"]}])
    b = _analysis(session, beta, "B", {"q_i": 2})
    _join(session, a, summary)
    _join(session, b, summary)
    rows = summary_table(session, summary["id"])["rows"]
    assert [r["project"]["name"] for r in rows] == ["Alpha", "Beta"]
    assert rows[0]["experiment"]["name"] == "Cooldown 7"
    assert rows[1]["experiment"] is None


def test_empty_summary_and_unknown_id(session: Session) -> None:
    summary = create_entity(session, "result_summary", {"name": "Empty"})
    table = summary_table(session, summary["id"])
    assert table["keys"] == [] and table["rows"] == [] and table["columns"] == []
    wafer = create_entity(session, "wafer", {"name": "W"})
    with pytest.raises(LookupError):
        summary_table(session, wafer["id"])
    with pytest.raises(LookupError):
        summary_table(session, uuid.uuid4())

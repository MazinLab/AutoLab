import pytest
from sqlmodel import Session

from labcore.lineage import add_edge, lineage
from labcore.models.edges import RelationType
from labcore.service import create_entity


def test_lineage_depth_zero_returns_no_neighbors(session: Session) -> None:
    wafer = create_entity(session, "wafer", {"name": "W1"})
    device = create_entity(session, "device", {"name": "D1"})
    add_edge(session, device["id"], RelationType.DERIVED_FROM, wafer["id"])

    assert lineage(session, device["id"], depth=0) == []


def test_lineage_rejects_negative_depth(session: Session) -> None:
    device = create_entity(session, "device", {"name": "D1"})

    with pytest.raises(ValueError, match="depth must be non-negative"):
        lineage(session, device["id"], depth=-1)

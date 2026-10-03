from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.api import labels
from app.config import Settings
from app.main import create_app
from labcore.events import list_events
from labcore.service import create_entity


def _label_print_events(engine: Engine) -> list[dict]:
    with Session(engine) as session:
        return [
            event
            for event in list_events(session, limit=1000)
            if event["action"] == "label_printed"
        ]


def test_print_api_attributes_label_event_to_header_actor(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    sent: list[tuple[str, int, str]] = []
    monkeypatch.setattr(
        labels,
        "_send_zpl",
        lambda host, port, zpl: sent.append((host, port, zpl)),
    )
    settings = Settings(printers={"bench": "printer.local:9100"})

    with TestClient(create_app(engine, settings=settings)) as client:
        actor = client.post("/api/agent", json={"name": "label bot"}).json()
        wafer = client.post("/api/wafer", json={"name": "W1"}).json()
        response = client.post(
            f"/api/entities/{wafer['id']}/print-label",
            json={"printer": "bench"},
            headers={"X-Actor-Id": actor["id"]},
        )

    assert response.status_code == 200
    assert len(sent) == 1
    events = _label_print_events(engine)
    assert len(events) == 1
    assert events[0]["actor_id"] == uuid.UUID(actor["id"])


@pytest.mark.parametrize("actor_kind", ["unknown", "wafer"])
def test_print_api_rejects_invalid_actor_before_sending(
    engine: Engine,
    monkeypatch: pytest.MonkeyPatch,
    actor_kind: str,
) -> None:
    sent: list[tuple[str, int, str]] = []
    monkeypatch.setattr(
        labels,
        "_send_zpl",
        lambda host, port, zpl: sent.append((host, port, zpl)),
    )
    settings = Settings(printers={"bench": "printer.local:9100"})

    with TestClient(create_app(engine, settings=settings)) as client:
        wafer = client.post("/api/wafer", json={"name": "W1"}).json()
        actor_id = str(uuid.uuid4()) if actor_kind == "unknown" else wafer["id"]
        response = client.post(
            f"/api/entities/{wafer['id']}/print-label",
            json={"printer": "bench"},
            headers={"X-Actor-Id": actor_id},
        )

    assert response.status_code == 422
    assert sent == []
    assert _label_print_events(engine) == []


def test_print_label_records_actor_without_committing(
    session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(labels, "_send_zpl", lambda host, port, zpl: None)
    actor = create_entity(session, "person", {"name": "Operator"})
    wafer = create_entity(session, "wafer", {"name": "W1"})
    settings = Settings(printers={"bench": "printer.local:9100"})

    with patch.object(session, "commit") as commit:
        labels.print_label(
            session,
            settings,
            wafer["id"],
            "bench",
            "qr",
            actor_id=actor["id"],
        )

    commit.assert_not_called()
    event = next(
        event
        for event in list_events(session, limit=1000)
        if event["action"] == "label_printed"
    )
    assert event["actor_id"] == actor["id"]

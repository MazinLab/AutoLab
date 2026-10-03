from __future__ import annotations

import socket
import socketserver
import threading
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.config import Settings
from app.main import create_app
from labcore.events import list_events
from labcore.labelprint import render_zpl
from app.api.labels import _local_date


class _CaptureHandler(socketserver.StreamRequestHandler):
    received: list[bytes] = []

    def handle(self) -> None:
        self.received.append(self.rfile.read())


def _expected_date(engine: Engine, entity_id: str) -> str:
    """The label's date line: created_at rendered in the lab timezone."""
    import uuid

    from labcore.service import get_entity

    with Session(engine) as session:
        entity = get_entity(session, uuid.UUID(entity_id))
    assert entity is not None
    return _local_date(entity["created_at"], Settings().label_timezone)


def _label_print_events(engine: Engine) -> list[dict]:
    with Session(engine) as session:
        return [
            event
            for event in list_events(session, limit=1000)
            if event["action"] == "label_printed"
        ]


def test_print_api_sends_exact_zpl_and_uses_first_printer_by_default(
    engine: Engine,
) -> None:
    _CaptureHandler.received = []
    with socketserver.ThreadingTCPServer(
        ("127.0.0.1", 0), _CaptureHandler
    ) as server:
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        settings = Settings(
            printers={"bench": f"127.0.0.1:{port}"},
            public_base_url="https://autolab.example",
        )

        with TestClient(create_app(engine, settings=settings)) as client:
            wafer = client.post("/api/wafer", json={"name": "W1"}).json()
            assert client.get("/api/printers").json() == ["bench"]

            response = client.post(
                f"/api/entities/{wafer['id']}/print-label", json={}
            )

        server.shutdown()
        thread.join()

    assert response.status_code == 200
    assert response.json() == {"printer": "bench", "format": "qr"}
    assert _CaptureHandler.received == [
        render_zpl(
            wafer["accession"],
            f"https://autolab.example/e/{wafer['accession']}",
            "W1",
            created_date=_expected_date(engine, wafer["id"]),
        ).encode("utf-8")
    ]
    events = _label_print_events(engine)
    assert len(events) == 1
    assert str(events[0]["entity_id"]) == wafer["id"]
    assert events[0]["payload"] == {"printer": "bench", "format": "qr"}


def test_configured_default_printer_overrides_first_name(engine: Engine) -> None:
    _CaptureHandler.received = []
    with socketserver.ThreadingTCPServer(
        ("127.0.0.1", 0), _CaptureHandler
    ) as server:
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        settings = Settings(
            printers={
                "first": "127.0.0.1:1",
                "preferred": f"127.0.0.1:{port}",
            },
            default_printer="preferred",
        )

        with TestClient(create_app(engine, settings=settings)) as client:
            wafer = client.post("/api/wafer", json={"name": "W1"}).json()
            response = client.post(
                f"/api/entities/{wafer['id']}/print-label", json={}
            )

        server.shutdown()
        thread.join()

    assert response.status_code == 200
    assert response.json()["printer"] == "preferred"
    assert len(_CaptureHandler.received) == 1


def test_print_api_sends_text_label_and_records_text_format(
    engine: Engine,
) -> None:
    _CaptureHandler.received = []
    with socketserver.ThreadingTCPServer(
        ("127.0.0.1", 0), _CaptureHandler
    ) as server:
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        settings = Settings(
            printers={"bench": f"127.0.0.1:{port}"},
            public_base_url="https://autolab.example",
        )

        with TestClient(create_app(engine, settings=settings)) as client:
            wafer = client.post("/api/wafer", json={"name": "W1"}).json()
            response = client.post(
                f"/api/entities/{wafer['id']}/print-label",
                json={"printer": "bench", "label_format": "text"},
            )

        server.shutdown()
        thread.join()

    assert response.status_code == 200
    assert response.json() == {"printer": "bench", "format": "text"}
    assert _CaptureHandler.received == [
        render_zpl(
            wafer["accession"],
            f"https://autolab.example/e/{wafer['accession']}",
            "W1",
            label_format="text",
            created_date=_expected_date(engine, wafer["id"]),
        ).encode("utf-8")
    ]
    events = _label_print_events(engine)
    assert len(events) == 1
    assert events[0]["payload"] == {"printer": "bench", "format": "text"}


def test_print_api_uses_lineage_label_when_name_is_empty(engine: Engine) -> None:
    _CaptureHandler.received = []
    with socketserver.ThreadingTCPServer(
        ("127.0.0.1", 0), _CaptureHandler
    ) as server:
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        port = server.server_address[1]
        settings = Settings(
            printers={"bench": f"127.0.0.1:{port}"},
            public_base_url="https://autolab.example",
        )

        with TestClient(create_app(engine, settings=settings)) as client:
            root = client.post("/api/wafer", json={"name": "Root"}).json()
            child = client.post("/api/device", json={"name": ""}).json()
            edge = client.post(
                "/api/edges",
                json={
                    "src_id": child["id"],
                    "relation": "derived_from",
                    "dst_id": root["id"],
                },
            )
            assert edge.status_code == 201
            response = client.post(
                f"/api/entities/{child['id']}/print-label", json={}
            )

        server.shutdown()
        thread.join()

    assert response.status_code == 200
    assert _CaptureHandler.received == [
        render_zpl(
            child["accession"],
            f"https://autolab.example/e/{child['accession']}",
            f"Root.{child['accession']}",
            created_date=_expected_date(engine, child["id"]),
        ).encode("utf-8")
    ]


@pytest.mark.parametrize(
    ("body", "detail"),
    [
        ({"printer": 7}, "printer must be a string"),
        ({"label_format": None}, "label_format must be a string"),
    ],
)
def test_print_api_rejects_non_string_options(
    engine: Engine,
    body: dict[str, object],
    detail: str,
) -> None:
    with TestClient(create_app(engine, settings=Settings())) as client:
        wafer = client.post("/api/wafer", json={"name": "W1"}).json()
        response = client.post(
            f"/api/entities/{wafer['id']}/print-label", json=body
        )

    assert response.status_code == 422
    assert response.json()["detail"] == detail
    assert _label_print_events(engine) == []


def test_print_api_rejects_unknown_format_without_event(engine: Engine) -> None:
    settings = Settings(printers={"bench": "127.0.0.1:1"})
    with TestClient(create_app(engine, settings=settings)) as client:
        wafer = client.post("/api/wafer", json={"name": "W1"}).json()
        response = client.post(
            f"/api/entities/{wafer['id']}/print-label",
            json={"label_format": "thermal"},
        )

    assert response.status_code == 400
    assert response.json()["detail"] == "Unknown label format: thermal"
    assert _label_print_events(engine) == []


def test_print_api_returns_404_for_unknown_entity_without_event(
    engine: Engine,
) -> None:
    entity_id = uuid.uuid4()
    with TestClient(create_app(engine, settings=Settings())) as client:
        response = client.post(
            f"/api/entities/{entity_id}/print-label", json={}
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "entity not found"
    assert _label_print_events(engine) == []


def test_print_api_failure_paths_do_not_record_events(engine: Engine) -> None:
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    dead_port = probe.getsockname()[1]
    probe.close()
    settings = Settings(printers={"dead": f"127.0.0.1:{dead_port}"})

    with TestClient(create_app(engine, settings=settings)) as client:
        wafer = client.post("/api/wafer", json={"name": "W1"}).json()
        unknown = client.post(
            f"/api/entities/{wafer['id']}/print-label",
            json={"printer": "unknown"},
        )
        unreachable = client.post(
            f"/api/entities/{wafer['id']}/print-label",
            json={"printer": "dead"},
        )

    assert unknown.status_code == 400
    assert unreachable.status_code == 502
    assert _label_print_events(engine) == []


def test_label_date_uses_lab_local_time_not_utc() -> None:
    """mec stores UTC; a wafer made at 5:30pm Pacific must not print as the
    next day."""
    from datetime import UTC, datetime

    from app.api.labels import _local_date

    just_after_midnight_utc = datetime(2026, 8, 24, 0, 30, tzinfo=UTC)

    assert _local_date(just_after_midnight_utc, "America/Los_Angeles") == (
        "08/23/26"
    )
    # A bad timezone must not cost anyone a label.
    assert _local_date(just_after_midnight_utc, "Not/AZone") == "08/24/26"
    assert _local_date(None, "America/Los_Angeles") == ""

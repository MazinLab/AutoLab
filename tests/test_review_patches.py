"""Regression tests for the 2026-08-08 adversarial-review patch round."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import inspect
from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.config import Settings
from app.main import create_app
from labcore.events import reset_submitted_by, set_submitted_by
from labcore.service import create_entity


def test_explicit_extra_object_merges_instead_of_nesting(
    client: TestClient,
) -> None:
    created = client.post(
        "/api/wafer",
        json={"name": "W", "extra": {"lot": "L1"}, "grower": "ACME"},
    ).json()
    fetched = client.get(f"/api/wafer/{created['id']}").json()
    assert fetched["extra"] == {"lot": "L1", "grower": "ACME"}
    hits = client.get("/api/wafer", params={"x.lot": "L1"}).json()
    assert [w["id"] for w in hits] == [created["id"]]


def test_explicit_extra_must_be_an_object(client: TestClient) -> None:
    response = client.post("/api/wafer", json={"name": "W", "extra": "nope"})
    assert response.status_code == 422


def test_deleted_events_survive_entity_type_feed_filter(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "doomed"}).json()
    assert (
        client.delete(f"/api/wafer/{wafer['id']}").status_code == 204
    )
    items = client.get(
        "/api/feed", params={"actions": "deleted", "entity_type": "wafer"}
    ).json()["items"]
    assert [i["payload"]["accession"] for i in items] == [wafer["accession"]]


def test_actor_cannot_delete_itself(client: TestClient) -> None:
    person = client.post("/api/person", json={"name": "Solo"}).json()
    response = client.delete(
        f"/api/person/{person['id']}",
        headers={"X-Actor-Id": person["id"]},
    )
    assert response.status_code == 409
    assert "cannot delete itself" in response.json()["detail"]


def test_person_login_unique_index_exists_in_schema(engine: Engine) -> None:
    indexes = {
        index["name"]: index for index in inspect(engine).get_indexes("person")
    }
    assert indexes["uq_person_tailscale_login"]["unique"]


def test_unmapped_login_is_recorded_on_the_event(engine: Engine) -> None:
    with Session(engine) as session:
        token = set_submitted_by(None, "ghost@tailnet")
        try:
            wafer = create_entity(session, "wafer", {"name": "W"})
            session.commit()
        finally:
            reset_submitted_by(token)
    with TestClient(create_app(engine)) as client:
        events = client.get(f"/api/entities/{wafer['id']}/events").json()[
            "events"
        ]
    created = [e for e in events if e["action"] == "created"]
    assert created[0]["payload"]["submitted_by_login"] == "ghost@tailnet"


def test_upload_dedup_skipped_when_existing_bytes_missing(
    engine: Engine, tmp_path: Path
) -> None:
    storage = tmp_path / "store"
    with TestClient(
        create_app(engine, settings=Settings(storage_root=storage))
    ) as client:
        first = client.post(
            "/api/artifacts/upload",
            files={"file": ("a.txt", io.BytesIO(b"payload"), "text/plain")},
        ).json()
        assert first["deduplicated"] is False
        (storage / first["uri"]).unlink()

        second = client.post(
            "/api/artifacts/upload",
            files={"file": ("a.txt", io.BytesIO(b"payload"), "text/plain")},
        ).json()
    assert second["deduplicated"] is False
    assert second["id"] != first["id"]
    assert (storage / second["uri"]).is_file()


def test_upload_refuses_symlinked_uploads_directory(
    engine: Engine, tmp_path: Path
) -> None:
    storage = tmp_path / "store"
    storage.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    (storage / "uploads").symlink_to(outside)
    with TestClient(
        create_app(engine, settings=Settings(storage_root=storage))
    ) as client:
        response = client.post(
            "/api/artifacts/upload",
            files={"file": ("a.txt", io.BytesIO(b"x"), "text/plain")},
        )
    # ELOOP on Linux, ENOTDIR on macOS — both must refuse and write nothing.
    assert response.status_code == 409
    assert "upload path" in response.json()["detail"]
    assert list(outside.iterdir()) == []


def test_chunked_upload_body_rejected_before_parsing(
    engine: Engine, tmp_path: Path
) -> None:
    settings = Settings(
        storage_root=tmp_path / "store", max_upload_bytes=1024
    )

    def body() -> object:
        for _ in range(3):
            yield b"x" * 1_000_000  # 3 MB total, no Content-Length

    with TestClient(create_app(engine, settings=settings)) as client:
        response = client.post(
            "/api/artifacts/upload",
            content=body(),
            headers={"Content-Type": "multipart/form-data; boundary=x"},
        )
    assert response.status_code == 413


def test_mcp_first_row_alone_cannot_exceed_response_cap(
    engine: Engine,
) -> None:
    from tests.test_mcp_server import _call_mcp_tool

    big_cell = (
        "repeat('0', 12000)"
        if engine.dialect.name == "postgresql"
        else "hex(zeroblob(6000))"
    )
    wide = ", ".join(
        f"{big_cell} AS c{i}" for i in range(30)
    )  # ~30 x 12kB bounded cells > 200kB response cap
    result = _call_mcp_tool(
        engine, "query_sql", {"sql": f"SELECT {wide}", "limit": 1}
    )
    assert result["rows"] == []
    assert result["truncated"] is True

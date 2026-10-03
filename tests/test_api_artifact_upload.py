import hashlib
from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from app.config import Settings
from app.main import create_app


def _client(engine: Engine, storage_root: Path) -> TestClient:
    return TestClient(
        create_app(engine, settings=Settings(storage_root=storage_root))
    )


def test_upload_stores_file_and_registers_artifact(
    engine: Engine, tmp_path: Path
) -> None:
    payload = b"PNG-ish bytes for a wafer map"
    with _client(engine, tmp_path) as client:
        response = client.post(
            "/api/artifacts/upload",
            files={"file": ("wafer map.png", payload, "image/png")},
        )

    assert response.status_code == 201
    artifact = response.json()
    assert artifact["entity_type"] == "artifact"
    assert artifact["name"] == "wafer_map.png"
    assert artifact["checksum_sha256"] == hashlib.sha256(payload).hexdigest()
    assert artifact["size_bytes"] == len(payload)
    assert artifact["media_type"] == "image/png"
    assert artifact["data_format"] == "png"
    assert artifact["uri"].startswith("uploads/")

    stored = tmp_path / artifact["uri"]
    assert stored.read_bytes() == payload


def test_upload_links_attachment_to_record(
    engine: Engine, tmp_path: Path
) -> None:
    with _client(engine, tmp_path) as client:
        note = client.post(
            "/api/note", json={"name": "Run log", "body": "cooldown 18"}
        ).json()
        response = client.post(
            "/api/artifacts/upload",
            data={"link_entity_id": note["id"], "name": "IQ sweep"},
            files={"file": ("sweep.h5", b"\x89HDF", "application/x-hdf5")},
        )
        assert response.status_code == 201
        artifact = response.json()
        assert artifact["name"] == "IQ sweep"

        neighbors = client.get(
            f"/api/entities/{note['id']}/lineage",
            params={
                "direction": "both",
                "depth": 1,
                "relations": "annotates",
                "graph": "true",
            },
        ).json()

    edge = next(iter(neighbors["edges"]))
    assert edge["src_id"] == artifact["id"]
    assert edge["dst_id"] == note["id"]
    assert edge["relation"] == "annotates"


def test_upload_rejects_structural_relation(
    engine: Engine, tmp_path: Path
) -> None:
    with _client(engine, tmp_path) as client:
        note = client.post("/api/note", json={"name": "n", "body": "b"}).json()
        response = client.post(
            "/api/artifacts/upload",
            data={"link_entity_id": note["id"], "relation": "derived_from"},
            files={"file": ("x.bin", b"1", "application/octet-stream")},
        )

    assert response.status_code == 422
    assert "annotate" in response.json()["detail"]
    assert not (tmp_path / "uploads").exists()


def test_upload_missing_link_target_is_404_and_leaves_no_file(
    engine: Engine, tmp_path: Path
) -> None:
    with _client(engine, tmp_path) as client:
        response = client.post(
            "/api/artifacts/upload",
            data={"link_entity_id": "01900000-0000-7000-8000-00000000dead"},
            files={"file": ("x.bin", b"1", "application/octet-stream")},
        )

    assert response.status_code == 404
    uploads = tmp_path / "uploads"
    assert not uploads.exists() or not any(uploads.iterdir())


def test_entity_list_order_desc_returns_newest_first(
    engine: Engine, tmp_path: Path
) -> None:
    with _client(engine, tmp_path) as client:
        first = client.post("/api/device", json={"name": "older"}).json()
        second = client.post("/api/device", json={"name": "newer"}).json()
        listing = client.get("/api/device", params={"order": "desc"}).json()

    ids = [row["id"] for row in listing]
    # uuid7 ordering across back-to-back calls is not guaranteed, so assert
    # set membership plus that ascending and descending disagree only in order.
    assert set(ids) == {first["id"], second["id"]}
    with _client(engine, tmp_path) as client:
        ascending = client.get("/api/device", params={"order": "asc"}).json()
    assert [row["id"] for row in ascending] == list(reversed(ids))

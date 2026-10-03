from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from app.config import Settings
from app.main import create_app


def test_download_artifact_streams_file(
    engine: Engine, tmp_path: Path
) -> None:
    payload = b"\x00\x01artifact bytes"
    artifact_path = tmp_path / "runs" / "measurement.bin"
    artifact_path.parent.mkdir()
    artifact_path.write_bytes(payload)

    with TestClient(
        create_app(engine, settings=Settings(storage_root=tmp_path))
    ) as client:
        artifact = client.post(
            "/api/artifact",
            json={"name": "measurement", "uri": "runs/measurement.bin"},
        ).json()
        response = client.get(
            f"/api/artifacts/{artifact['id']}/download"
        )

    assert response.status_code == 200
    assert response.content == payload
    assert int(response.headers["content-length"]) == len(payload)


def test_create_artifact_rejects_uri_outside_storage_root(
    engine: Engine, tmp_path: Path
) -> None:
    storage_root = tmp_path / "store"
    storage_root.mkdir()
    outside = tmp_path / "outside.bin"
    outside.write_bytes(b"secret")

    with TestClient(
        create_app(engine, settings=Settings(storage_root=storage_root))
    ) as client:
        traversal = client.post(
            "/api/artifact",
            json={"name": "traversal", "uri": "../outside.bin"},
        )
        absolute = client.post(
            "/api/artifact",
            json={"name": "absolute", "uri": str(outside)},
        )

    assert traversal.status_code == 400
    assert absolute.status_code == 400


def test_download_rejects_preexisting_row_with_escaping_uri(
    engine: Engine, tmp_path: Path
) -> None:
    """Defense in depth: a bad URI already in the DB still cannot be served."""
    from sqlmodel import Session

    from labcore.service import create_entity

    storage_root = tmp_path / "store"
    storage_root.mkdir()
    (tmp_path / "outside.bin").write_bytes(b"secret")
    with Session(engine) as session:
        artifact = create_entity(
            session, "artifact", {"name": "legacy", "uri": "../outside.bin"}
        )
        session.commit()

    with TestClient(
        create_app(engine, settings=Settings(storage_root=storage_root))
    ) as client:
        response = client.get(f"/api/artifacts/{artifact['id']}/download")

    assert response.status_code == 400


def test_create_artifact_validates_checksum_and_size(
    engine: Engine, tmp_path: Path
) -> None:
    with TestClient(
        create_app(engine, settings=Settings(storage_root=tmp_path))
    ) as client:
        bad_checksum = client.post(
            "/api/artifact",
            json={"name": "bad checksum", "checksum_sha256": "not-a-digest"},
        )
        bad_size = client.post(
            "/api/artifact",
            json={"name": "bad size", "size_bytes": -1},
        )
        good = client.post(
            "/api/artifact",
            json={"name": "good", "checksum_sha256": "a" * 64, "size_bytes": 0},
        )

    assert bad_checksum.status_code == 422
    assert "checksum_sha256" in bad_checksum.json()["detail"]
    assert bad_size.status_code == 422
    assert "size_bytes" in bad_size.json()["detail"]
    assert good.status_code == 201


def test_download_forces_attachment_and_blocks_active_content(
    engine: Engine, tmp_path: Path
) -> None:
    page = tmp_path / "report.html"
    page.write_text("<script>alert(1)</script>", encoding="utf-8")

    with TestClient(
        create_app(engine, settings=Settings(storage_root=tmp_path))
    ) as client:
        artifact = client.post(
            "/api/artifact",
            json={
                "name": "report",
                "uri": "report.html",
                "media_type": "text/html",
            },
        ).json()
        response = client.get(f"/api/artifacts/{artifact['id']}/download")

    assert response.status_code == 200
    disposition = response.headers["content-disposition"]
    assert disposition.startswith("attachment")
    assert "report.html" in disposition
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-security-policy"] == "sandbox"


def test_download_artifact_returns_404_for_missing_file(
    engine: Engine, tmp_path: Path
) -> None:
    with TestClient(
        create_app(engine, settings=Settings(storage_root=tmp_path))
    ) as client:
        stored = tmp_path / "missing.bin"
        stored.write_bytes(b"here for registration, gone before download")
        artifact = client.post(
            "/api/artifact",
            json={"name": "missing", "uri": "missing.bin"},
        ).json()
        stored.unlink()
        response = client.get(
            f"/api/artifacts/{artifact['id']}/download"
        )

    assert response.status_code == 404


def test_source_key_replay_through_api(client: TestClient) -> None:
    first = client.post(
        "/api/wafer", json={"name": "W1", "source_key": "api:wafer:1"}
    )
    replay = client.post(
        "/api/wafer", json={"name": "ignored", "source_key": "api:wafer:1"}
    )

    assert first.status_code == 201
    assert replay.status_code == 201
    assert replay.json()["id"] == first.json()["id"]
    assert replay.json()["name"] == "W1"
    assert "source_key" not in replay.json()["extra"]


def test_supersede_artifact_honors_actor_header(client: TestClient) -> None:
    actor = client.post("/api/agent", json={"name": "ingest agent"}).json()
    original = client.post(
        "/api/artifact", json={"name": "v1", "role": "raw"}
    ).json()

    response = client.post(
        f"/api/artifacts/{original['id']}/supersede",
        json={"name": "v2", "role": "raw"},
        headers={"X-Actor-Id": actor["id"]},
    )

    assert response.status_code == 201
    assert response.json()["created_by_id"] == actor["id"]


def test_supersede_artifact_creates_replacement_lineage(
    client: TestClient,
) -> None:
    original = client.post(
        "/api/artifact",
        json={"name": "v1", "role": "raw", "checksum_sha256": "a" * 64},
    ).json()

    response = client.post(
        f"/api/artifacts/{original['id']}/supersede",
        json={"name": "v2", "role": "raw", "checksum_sha256": "b" * 64},
    )

    assert response.status_code == 201
    replacement = response.json()
    assert replacement["id"] != original["id"]
    lineage = client.get(
        f"/api/entities/{replacement['id']}/lineage",
        params={"direction": "up"},
    )
    assert lineage.status_code == 200
    assert [entity["id"] for entity in lineage.json()] == [original["id"]]


def test_supersede_artifact_rejects_non_artifact(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    response = client.post(
        f"/api/artifacts/{wafer['id']}/supersede",
        json={"name": "replacement"},
    )

    assert response.status_code == 422

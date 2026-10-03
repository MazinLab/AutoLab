import hashlib
import os
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from app.config import Settings
from app.main import create_app


@pytest.fixture()
def store(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture()
def client(engine: Engine, store: Path) -> Iterator[TestClient]:
    settings = Settings(storage_root=store, max_upload_bytes=1024)
    with TestClient(create_app(engine, settings=settings)) as c:
        yield c


def _upload(client: TestClient, payload: bytes, filename: str = "data.bin"):
    return client.post(
        "/api/artifacts/upload",
        files={"file": (filename, payload, "application/octet-stream")},
    )


def test_upload_marks_original_raw_and_immutable(client: TestClient) -> None:
    artifact = _upload(client, b"raw bytes").json()

    assert artifact["role"] == "raw"
    assert artifact["deduplicated"] is False
    response = client.patch(
        f"/api/artifact/{artifact['id']}",
        json={"uri": "elsewhere.bin"},
    )
    assert response.status_code == 422
    assert "raw artifact" in response.json()["detail"]


def test_upload_dedups_identical_bytes(
    client: TestClient, store: Path
) -> None:
    first = _upload(client, b"same bytes").json()
    second = _upload(client, b"same bytes", filename="copy.bin").json()

    assert second["id"] == first["id"]
    assert second["deduplicated"] is True
    stored = [p for p in (store / "uploads").rglob("*") if p.is_file()]
    assert len(stored) == 1


def test_upload_over_cap_is_rejected_and_leaves_no_file(
    client: TestClient, store: Path
) -> None:
    response = _upload(client, b"x" * 2048)

    assert response.status_code == 413
    assert not any(
        p.is_file() for p in (store / "uploads").rglob("*")
    ) if (store / "uploads").is_dir() else True
    assert client.get("/api/artifact").json() == []


def test_register_with_wrong_checksum_is_rejected(
    client: TestClient, store: Path
) -> None:
    (store / "run.h5").write_bytes(b"real bytes")

    response = client.post(
        "/api/artifact",
        json={
            "name": "run",
            "uri": "run.h5",
            "checksum_sha256": "0" * 64,
        },
    )

    assert response.status_code == 422
    assert "checksum" in response.json()["detail"]


def test_register_with_wrong_size_is_rejected(
    client: TestClient, store: Path
) -> None:
    (store / "run.h5").write_bytes(b"real bytes")

    response = client.post(
        "/api/artifact",
        json={"name": "run", "uri": "run.h5", "size_bytes": 1},
    )

    assert response.status_code == 422
    assert "size" in response.json()["detail"]


def test_register_missing_file_is_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/artifact", json={"name": "ghost", "uri": "ghost.h5"}
    )

    assert response.status_code == 422


def test_register_fills_checksum_and_size_from_bytes(
    client: TestClient, store: Path
) -> None:
    payload = b"measured bytes"
    (store / "run.h5").write_bytes(payload)

    artifact = client.post(
        "/api/artifact", json={"name": "run", "uri": "run.h5"}
    ).json()

    assert artifact["checksum_sha256"] == hashlib.sha256(payload).hexdigest()
    assert artifact["size_bytes"] == len(payload)


def test_register_without_uri_skips_verification(client: TestClient) -> None:
    response = client.post("/api/artifact", json={"name": "placeholder"})

    assert response.status_code == 201


def test_download_refuses_symlinked_path(
    client: TestClient, store: Path, tmp_path_factory: pytest.TempPathFactory
) -> None:
    outside = tmp_path_factory.mktemp("outside") / "secret.txt"
    outside.write_bytes(b"outside the store")
    inner = store / "dir"
    inner.mkdir()
    (inner / "file.bin").write_bytes(b"legit")
    artifact = client.post(
        "/api/artifact", json={"name": "f", "uri": "dir/file.bin"}
    ).json()

    # Swap the checked directory for a symlink AFTER registration — the
    # classic check/open race, collapsed into its worst case.
    (inner / "file.bin").unlink()
    inner.rmdir()
    os.symlink(outside.parent, inner)

    response = client.get(f"/api/artifacts/{artifact['id']}/download")

    assert response.status_code == 400
    assert b"outside the store" not in response.content

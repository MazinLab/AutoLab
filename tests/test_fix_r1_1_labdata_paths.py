from __future__ import annotations

import importlib
import uuid
from pathlib import Path
from types import SimpleNamespace

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.config import Settings
from app.main import create_app
from app.watcher import scan_storage
from labdata import LabData, Spool, save

save_module = importlib.import_module("labdata.save")


def test_save_registers_nested_uri_relative_to_storage_root(
    engine: Engine, tmp_path: Path
) -> None:
    storage_root = tmp_path / "storage"
    settings = Settings(storage_root=storage_root)

    with TestClient(create_app(engine, settings)) as http:
        result = save(
            np.arange(4),
            kind="array",
            name="nested sweep",
            storage_dir=storage_root,
            subdir=Path("vna") / "2026",
            client=LabData(http),
            spool=Spool(tmp_path / "spool"),
        )
        path = Path(result["path"])
        artifact = result["artifact"]
        response = http.get(f"/api/artifacts/{artifact['id']}/download")

    assert artifact["uri"] == f"vna/2026/{path.name}"
    assert response.status_code == 200
    assert response.content == path.read_bytes()
    with Session(engine) as session:
        assert scan_storage(session, storage_root) == []


def test_same_prefix_operation_ids_create_distinct_files(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    operation_ids = (
        uuid.UUID("12345678-1234-4000-8000-000000000001"),
        uuid.UUID("aaaaaaaa-aaaa-4000-8000-000000000001"),
        uuid.UUID("12345678-1234-4000-8000-000000000002"),
        uuid.UUID("aaaaaaaa-aaaa-4000-8000-000000000002"),
    )
    generated_ids = iter(operation_ids)
    monkeypatch.setattr(
        save_module,
        "uuid",
        SimpleNamespace(uuid4=lambda: next(generated_ids)),
    )

    def unavailable(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("catalog unavailable", request=request)

    with httpx.Client(
        transport=httpx.MockTransport(unavailable),
        base_url="http://catalog",
    ) as http:
        client = LabData(http)
        spool = Spool(tmp_path / "spool")
        first = save(
            np.zeros(2),
            kind="array",
            name="same name",
            storage_dir=tmp_path / "storage",
            client=client,
            spool=spool,
        )
        second = save(
            np.ones(2),
            kind="array",
            name="same name",
            storage_dir=tmp_path / "storage",
            client=client,
            spool=spool,
        )

    first_path = Path(first["path"])
    second_path = Path(second["path"])
    assert first_path.name.endswith(f"{operation_ids[0].hex}.h5")
    assert second_path.name.endswith(f"{operation_ids[2].hex}.h5")
    assert first_path != second_path
    assert first_path.exists()
    assert second_path.exists()


def test_atomic_write_does_not_replace_existing_file(tmp_path: Path) -> None:
    path = tmp_path / "existing.h5"
    path.write_bytes(b"original bytes")

    with pytest.raises(FileExistsError):
        save_module._write_atomically(path, np.arange(3), "array")

    assert path.read_bytes() == b"original bytes"

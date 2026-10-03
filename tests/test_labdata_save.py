from __future__ import annotations

import hashlib
from pathlib import Path

import h5py
import numpy as np
import pyarrow.parquet as pq
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.main import create_app
from labcore.models.edges import ProvenanceEdge
from labcore.service import create_entity
from labdata import LabData, Spool, SpoolJournalError, save


def test_save_array_registers_artifact_and_provenance(
    engine: Engine, tmp_path: Path
) -> None:
    with Session(engine) as session:
        producer = create_entity(session, "instrument", {"name": "VNA"})
        actor = create_entity(session, "agent", {"name": "labdata writer"})
        related = create_entity(session, "device", {"name": "resonator"})
        session.commit()

    storage_dir = tmp_path / "storage"
    with TestClient(
        create_app(engine, settings=Settings(storage_root=storage_dir))
    ) as http:
        result = save(
            np.arange(12, dtype="f8").reshape(3, 4),
            kind="array",
            name="IQ sweep",
            storage_dir=storage_dir,
            client=LabData(http, actor_id=actor["id"]),
            spool=Spool(tmp_path / "spool"),
            producer_id=producer["id"],
            related_ids=(related["id"],),
            extra={"temperature_mk": 95},
        )

    path = Path(result["path"])
    assert result["pending"] is False
    assert result["artifact"] is not None
    assert path.name.startswith("iq-sweep-")
    assert path.suffix == ".h5"
    assert hashlib.sha256(path.read_bytes()).hexdigest() == result[
        "checksum_sha256"
    ]
    with h5py.File(path) as h5:
        np.testing.assert_array_equal(h5["data"][:], np.arange(12).reshape(3, 4))
        assert not h5.attrs

    artifact = result["artifact"]
    assert artifact["checksum_sha256"] == result["checksum_sha256"]
    assert artifact["created_by_id"] == str(actor["id"])
    assert artifact["role"] == "raw"
    assert artifact["schema_version"] == "1"
    assert artifact["data_format"] == "hdf5"
    assert artifact["extra"] == {"temperature_mk": 95}
    with Session(engine) as session:
        edges = session.exec(select(ProvenanceEdge)).all()
    assert {
        (str(edge.src_id), edge.relation, str(edge.dst_id)) for edge in edges
    } == {
        (str(artifact["id"]), "produced_by", str(producer["id"])),
        (str(artifact["id"]), "refers_to", str(related["id"])),
    }


@pytest.mark.parametrize("kind", ["table", "events"])
def test_save_table_and_events_register_parquet_artifacts(
    engine: Engine, tmp_path: Path, kind: str
) -> None:
    data = {"frequency_hz": [4.0, 5.0], "power_dbm": [-80.0, -79.5]}
    storage_dir = tmp_path / "storage"

    with TestClient(
        create_app(engine, settings=Settings(storage_root=storage_dir))
    ) as http:
        result = save(
            data,
            kind=kind,
            name="resonator events",
            storage_dir=storage_dir,
            client=LabData(http),
            spool=Spool(tmp_path / "spool"),
        )

    path = Path(result["path"])
    assert result["pending"] is False
    assert path.suffix == ".parquet"
    assert pq.read_table(path).to_pydict() == data

    artifact = result["artifact"]
    assert artifact is not None
    assert artifact["uri"] == path.relative_to(storage_dir).as_posix()
    assert artifact["size_bytes"] == path.stat().st_size
    assert artifact["data_format"] == "parquet"
    assert artifact["role"] == "raw"
    assert artifact["schema_version"] == "1"


def test_save_preserves_data_file_when_journal_write_fails(
    tmp_path: Path,
) -> None:
    import json

    import httpx

    class BrokenSpool(Spool):
        def journal(self, op_id, entry):  # type: ignore[override]
            raise OSError("spool disk full")

    storage_dir = tmp_path / "storage"
    with httpx.Client(base_url="http://unused") as http:
        with pytest.raises(SpoolJournalError) as excinfo:
            save(
                np.arange(4, dtype="f8"),
                kind="array",
                name="survives spool failure",
                storage_dir=storage_dir,
                client=LabData(http),
                spool=BrokenSpool(tmp_path / "spool"),
            )

    error = excinfo.value
    assert error.data_path.is_file(), "acquisition file must be preserved"
    with h5py.File(error.data_path) as h5:
        np.testing.assert_array_equal(h5["data"][:], np.arange(4))
    assert error.sidecar_path is not None and error.sidecar_path.is_file()
    sidecar = json.loads(error.sidecar_path.read_text(encoding="utf-8"))
    assert sidecar["source_key"] == error.source_key
    assert sidecar["artifact"]["name"] == "survives spool failure"


def test_save_rejects_metadata_that_overwrites_artifact_fields(
    tmp_path: Path,
) -> None:
    import httpx

    storage_dir = tmp_path / "storage"
    with httpx.Client(base_url="http://unused") as http:
        with pytest.raises(ValueError, match="conflict"):
            save(
                np.ones(2),
                kind="array",
                name="protected metadata",
                storage_dir=storage_dir,
                client=LabData(http),
                spool=Spool(tmp_path / "spool"),
                extra={"checksum_sha256": "forged"},
            )

    assert not storage_dir.exists()

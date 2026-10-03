"""Measurement sessions: context auto-linking, idempotent run creation,
env configuration, and the spool CLI."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.main import create_app
from labcore.models.edges import ProvenanceEdge
from labcore.service import create_entity
from labdata import LabData, Spool
from labdata.session import MeasurementSession


@pytest.fixture()
def lab(engine: Engine, tmp_path: Path):
    with Session(engine) as session:
        instrument = create_entity(session, "instrument", {"name": "VNA"})
        setup = create_entity(
            session, "experiment_setup", {"name": "Cooldown 12"}
        )
        device = create_entity(session, "device", {"name": "resonator A"})
        actor = create_entity(session, "agent", {"name": "vna writer"})
        session.commit()
    storage_dir = tmp_path / "storage"
    with TestClient(
        create_app(engine, settings=Settings(storage_root=storage_dir))
    ) as http:
        yield {
            "session": MeasurementSession(
                client=LabData(http, actor_id=actor["id"]),
                storage_dir=storage_dir,
                spool=Spool(tmp_path / "spool"),
                producer_id=instrument["id"],
                setup_id=setup["id"],
                device_id=device["id"],
            ),
            "instrument": instrument,
            "setup": setup,
            "device": device,
        }


def _edges(engine: Engine, src_id) -> set[tuple[str, str]]:
    import uuid

    with Session(engine) as session:
        rows = session.exec(
            select(ProvenanceEdge).where(
                ProvenanceEdge.src_id == uuid.UUID(str(src_id))
            )
        ).all()
    return {(edge.relation, str(edge.dst_id)) for edge in rows}


def test_start_run_creates_semantic_edges(engine: Engine, lab: dict) -> None:
    run = lab["session"].start_run(
        "Dark sweep", source_key="vna:run:2026-08-08", kind="iq_sweep"
    )
    assert run["kind"] == "iq_sweep"
    assert _edges(engine, run["id"]) == {
        ("measured_in", str(lab["setup"]["id"])),
        ("performed_on", str(lab["device"]["id"])),
        ("produced_by", str(lab["instrument"]["id"])),
    }
    assert lab["session"].run_id == run["id"]


def test_start_run_replays_idempotently(engine: Engine, lab: dict) -> None:
    first = lab["session"].start_run("Dark sweep", source_key="vna:run:1")
    again = lab["session"].start_run("Dark sweep", source_key="vna:run:1")
    assert again["id"] == first["id"]
    assert len(_edges(engine, first["id"])) == 3


def test_session_save_links_artifact_to_context(
    engine: Engine, lab: dict
) -> None:
    run = lab["session"].start_run("Dark sweep", source_key="vna:run:2")
    result = lab["session"].save(
        np.arange(6, dtype="f8"), kind="array", name="sweep 001"
    )
    assert result["pending"] is False
    linked = _edges(engine, result["artifact"]["id"])
    assert ("refers_to", str(run["id"])) in linked
    assert ("refers_to", str(lab["setup"]["id"])) in linked
    assert ("refers_to", str(lab["device"]["id"])) in linked
    assert ("produced_by", str(lab["instrument"]["id"])) in linked


def test_session_from_env_builds_configured_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from labdata.config import session_from_env

    monkeypatch.setenv("AUTOLAB_URL", "http://catalog.example:8000")
    monkeypatch.setenv(
        "AUTOLAB_ACTOR_ID", "01900000-0000-7000-8000-000000000042"
    )
    monkeypatch.setenv("AUTOLAB_STORAGE_DIR", str(tmp_path / "store"))
    monkeypatch.setenv("AUTOLAB_SPOOL_DIR", str(tmp_path / "spool"))
    built = session_from_env(setup_id="01900000-0000-7000-8000-000000000001")
    try:
        assert str(built.client.http.base_url) == "http://catalog.example:8000"
        assert built.client.actor_id == "01900000-0000-7000-8000-000000000042"
        assert built.producer_id == "01900000-0000-7000-8000-000000000042"
        assert built.storage_dir == tmp_path / "store"
        assert built.spool.dir == tmp_path / "spool"
        assert built.setup_id == "01900000-0000-7000-8000-000000000001"
    finally:
        built.client.close()


def test_session_from_env_requires_url(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from labdata.config import session_from_env

    monkeypatch.delenv("AUTOLAB_URL", raising=False)
    with pytest.raises(RuntimeError, match="AUTOLAB_URL"):
        session_from_env()


def test_cli_status_and_flush_on_empty_spool(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture,
) -> None:
    from labdata.__main__ import main

    monkeypatch.setenv("AUTOLAB_URL", "http://catalog.example:8000")
    monkeypatch.setenv("AUTOLAB_SPOOL_DIR", str(tmp_path / "spool"))
    assert main(["status"]) == 0
    assert "pending: 0" in capsys.readouterr().out
    # empty spool: flush never touches the network and exits clean
    assert main(["flush"]) == 0
    assert "registered 0" in capsys.readouterr().out

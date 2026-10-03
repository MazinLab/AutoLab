from __future__ import annotations

import uuid
from pathlib import Path

import httpx
import numpy as np
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.main import create_app
from labcore.models.edges import ProvenanceEdge
from labcore.models.entities import Artifact
from labcore.service import create_entity
from labdata import LabData, Spool, save


def _artifact_count(engine: Engine) -> int:
    with Session(engine) as session:
        return len(session.exec(select(Artifact)).all())


def test_failed_save_is_spooled_and_replay_is_idempotent(
    engine: Engine, tmp_path: Path
) -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("api down", request=request)

    spool = Spool(tmp_path / "spool")
    dead = LabData(
        httpx.Client(
            transport=httpx.MockTransport(down), base_url="http://down"
        )
    )
    result = save(
        np.ones(8),
        kind="array",
        name="offline sweep",
        storage_dir=tmp_path / "storage",
        client=dead,
        spool=spool,
    )

    assert result["pending"] is True
    assert result["artifact"] is None
    assert Path(result["path"]).exists()
    assert len(spool.pending()) == 1
    assert _artifact_count(engine) == 0

    with TestClient(
        create_app(
            engine, settings=Settings(storage_root=tmp_path / "storage"),
        )
    ) as http:
        live = LabData(http)
        assert spool.flush(live) == 1
        assert spool.flush(live) == 0

    assert not spool.pending()
    assert _artifact_count(engine) == 1


def test_http_4xx_dead_letters_and_surfaces_the_error(tmp_path: Path) -> None:
    def reject(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, request=request, json={"detail": "bad"})

    spool = Spool(tmp_path / "spool")
    client = LabData(
        httpx.Client(
            transport=httpx.MockTransport(reject), base_url="http://reject"
        )
    )
    result = save(
        np.zeros(2),
        kind="array",
        name="rejected",
        storage_dir=tmp_path / "storage",
        client=client,
        spool=spool,
    )

    # a permanent rejection never blocks acquisition, but it is not silently
    # retried either: the entry moves to dead/ and the caller sees the error
    assert result["pending"] is False
    assert result["artifact"] is None
    assert result["error"] is not None and "422" in result["error"]
    assert Path(result["path"]).exists()
    assert not spool.pending()
    assert len(spool.dead()) == 1
    assert spool.flush(client) == 0


def test_http_5xx_stays_pending_and_retryable(tmp_path: Path) -> None:
    def unavailable(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, request=request, json={"detail": "down"})

    spool = Spool(tmp_path / "spool")
    client = LabData(
        httpx.Client(
            transport=httpx.MockTransport(unavailable),
            base_url="http://flaky",
        )
    )
    result = save(
        np.zeros(2),
        kind="array",
        name="retryable",
        storage_dir=tmp_path / "storage",
        client=client,
        spool=spool,
    )

    assert result["pending"] is True
    assert result["error"] is None
    assert len(spool.pending()) == 1
    assert not spool.dead()
    assert spool.flush(client) == 0
    assert len(spool.pending()) == 1


def test_flush_dead_letters_rejected_entries(tmp_path: Path) -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("api down", request=request)

    def reject(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, request=request, json={"detail": "bad"})

    spool = Spool(tmp_path / "spool")
    save(
        np.zeros(2),
        kind="array",
        name="spooled offline",
        storage_dir=tmp_path / "storage",
        client=LabData(
            httpx.Client(
                transport=httpx.MockTransport(down), base_url="http://down"
            )
        ),
        spool=spool,
    )
    assert len(spool.pending()) == 1

    rejecting = LabData(
        httpx.Client(
            transport=httpx.MockTransport(reject), base_url="http://reject"
        )
    )
    assert spool.flush(rejecting) == 0
    assert not spool.pending()
    assert len(spool.dead()) == 1


def test_registration_with_links_is_replayed_atomically_from_spool(
    engine: Engine, tmp_path: Path
) -> None:
    """Registration carries its edges inline, so there is no partial state to
    repair: a transient failure spools the whole entry, and one replayed call
    commits the artifact and its provenance together."""
    with Session(engine) as session:
        producer = create_entity(session, "instrument", {"name": "VNA"})
        session.commit()

    def fail_registration(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("catalog unavailable", request=request)

    spool = Spool(tmp_path / "spool")
    with httpx.Client(
        transport=httpx.MockTransport(fail_registration),
        base_url="http://catalog",
    ) as raw_http:
        result = save(
            np.ones(4),
            kind="array",
            name="partially registered sweep",
            storage_dir=tmp_path / "storage",
            client=LabData(raw_http),
            spool=spool,
            producer_id=producer["id"],
        )

    assert result["pending"] is True
    assert len(spool.pending()) == 1

    with TestClient(
        create_app(
            engine, settings=Settings(storage_root=tmp_path / "storage"),
        )
    ) as http:
        assert spool.flush(LabData(http)) == 1

    with Session(engine) as session:
        artifact_rows = session.exec(select(Artifact)).all()
        edges = session.exec(select(ProvenanceEdge)).all()

    assert len(artifact_rows) == 1
    assert [edge.relation for edge in edges] == ["produced_by"]
    assert edges[0].dst_id == producer["id"]
    assert edges[0].src_id == artifact_rows[0].id


def test_identical_data_from_independent_saves_stays_distinct(
    engine: Engine, tmp_path: Path
) -> None:
    spool = Spool(tmp_path / "spool")
    data = np.ones(4)
    with TestClient(
        create_app(
            engine, settings=Settings(storage_root=tmp_path / "storage"),
        )
    ) as http:
        client = LabData(http)
        first = save(
            data,
            kind="array",
            name="same",
            storage_dir=tmp_path / "storage",
            client=client,
            spool=spool,
        )
        second = save(
            data,
            kind="array",
            name="same",
            storage_dir=tmp_path / "storage",
            client=client,
            spool=spool,
        )

    assert first["source_key"] != second["source_key"]
    assert first["path"] != second["path"]
    assert first["artifact"]["id"] != second["artifact"]["id"]
    assert _artifact_count(engine) == 2

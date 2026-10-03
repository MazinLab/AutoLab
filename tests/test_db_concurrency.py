"""File-backed SQLite must give every session its own connection.

A single shared StaticPool connection interleaves overlapping sessions'
transactions: writes get acknowledged and then swept away by another
session's rollback. These tests pin the per-connection behavior.
"""

from __future__ import annotations

import threading
from pathlib import Path

from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, select

import labcore.models  # noqa: F401  (registers tables on the metadata)
from labcore.db import make_engine
from labcore.models.base import EntityRegistry
from labcore.service import create_entity


def test_in_memory_sqlite_keeps_static_pool() -> None:
    engine = make_engine("sqlite://")
    assert isinstance(engine.pool, StaticPool)
    engine.dispose()


def test_file_backed_sqlite_uses_separate_connections(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'catalog.db'}")
    assert not isinstance(engine.pool, StaticPool)
    with engine.connect() as first, engine.connect() as second:
        assert (
            first.connection.driver_connection
            is not second.connection.driver_connection
        )
    engine.dispose()


def test_concurrent_sessions_all_persist(tmp_path: Path) -> None:
    engine = make_engine(f"sqlite:///{tmp_path / 'catalog.db'}")
    SQLModel.metadata.create_all(engine)
    n_writers = 20
    barrier = threading.Barrier(n_writers)
    errors: list[Exception] = []

    def write(index: int) -> None:
        try:
            barrier.wait()
            with Session(engine) as session:
                create_entity(session, "person", {"name": f"writer-{index}"})
                session.commit()
        except Exception as exc:  # collected: assertion below reports them
            errors.append(exc)

    threads = [
        threading.Thread(target=write, args=(index,))
        for index in range(n_writers)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert errors == []
    with Session(engine) as session:
        persisted = session.exec(select(EntityRegistry)).all()
    assert len(persisted) == n_writers
    assert len({row.accession for row in persisted}) == n_writers
    engine.dispose()

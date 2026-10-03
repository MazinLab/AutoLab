import os
import time
from pathlib import Path

import pytest
from sqlmodel import Session, select

import app.watcher as watcher
from labcore.models.entities import ReviewTask
from labcore.service import create_entity


def _review_tasks(session: Session) -> list[ReviewTask]:
    return list(session.exec(select(ReviewTask)).all())


@pytest.mark.parametrize(
    "uri", ["./runs/claimed.h5", "runs/../runs/claimed.h5"]
)
def test_scan_storage_matches_canonical_artifact_uri(
    session: Session, tmp_path: Path, uri: str
) -> None:
    data_path = tmp_path / "runs" / "claimed.h5"
    data_path.parent.mkdir()
    data_path.write_bytes(b"cataloged")
    create_entity(session, "artifact", {"name": "claimed", "uri": uri})

    assert watcher.scan_storage(session, tmp_path) == []
    assert _review_tasks(session) == []


def test_scan_storage_defers_young_files_during_grace_period(
    session: Session, tmp_path: Path
) -> None:
    data_path = tmp_path / "new.h5"
    data_path.write_bytes(b"still registering")

    assert watcher.scan_storage(
        session, tmp_path, age_grace_seconds=60.0
    ) == []

    old_time = time.time() - 61.0
    os.utime(data_path, (old_time, old_time))

    assert len(
        watcher.scan_storage(session, tmp_path, age_grace_seconds=60.0)
    ) == 1


def test_scan_storage_resolves_mid_scan_registration_in_same_scan(
    session: Session, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The scan uses ONE registered-URI snapshot (the per-file requery made it
    O(files x artifacts)); an artifact registered mid-scan may briefly get an
    open task, but the same scan's final reconcile pass resolves it."""
    data_path = tmp_path / "race.h5"
    data_path.write_bytes(b"registered during scan")
    original_query = watcher._registered_artifact_uris
    query_count = 0

    def register_during_scan(
        current_session: Session, storage_root: Path
    ) -> set[str]:
        nonlocal query_count
        query_count += 1
        if query_count == 2:
            create_entity(
                current_session,
                "artifact",
                {"name": "race", "uri": "./race.h5"},
            )
        return original_query(current_session, storage_root)

    monkeypatch.setattr(
        watcher, "_registered_artifact_uris", register_during_scan
    )

    task_ids = watcher.scan_storage(session, tmp_path)
    assert query_count == 2
    tasks = _review_tasks(session)
    assert [task.id for task in tasks] == task_ids
    assert [task.status for task in tasks] == ["resolved"]


def test_scan_storage_resolves_task_after_artifact_registration(
    session: Session, tmp_path: Path
) -> None:
    data_path = tmp_path / "runs" / "eventually-claimed.h5"
    data_path.parent.mkdir()
    data_path.write_bytes(b"registered after first scan")
    task_ids = watcher.scan_storage(session, tmp_path)
    assert len(task_ids) == 1

    create_entity(
        session,
        "artifact",
        {
            "name": "eventually claimed",
            "uri": "runs/../runs/eventually-claimed.h5",
        },
    )

    assert watcher.scan_storage(session, tmp_path) == []
    task = session.get(ReviewTask, task_ids[0])
    assert task is not None
    assert task.status == "resolved"

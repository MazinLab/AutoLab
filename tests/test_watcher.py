from pathlib import Path

from sqlmodel import Session, select

from app.watcher import scan_storage
from labcore.events import list_events
from labcore.models.entities import ReviewTask
from labcore.service import create_entity


def _review_tasks(session: Session) -> list[ReviewTask]:
    return list(session.exec(select(ReviewTask)).all())


def test_scan_storage_creates_one_idempotent_review_task(
    session: Session, tmp_path: Path
) -> None:
    runs_path = tmp_path / "runs"
    runs_path.mkdir()
    unregistered_path = runs_path / "stray.h5"
    unregistered_path.write_bytes(b"orphan bytes")
    file_stat = unregistered_path.stat()

    first_ids = scan_storage(session, tmp_path)

    assert len(first_ids) == 1
    tasks = _review_tasks(session)
    assert len(tasks) == 1
    assert tasks[0].id == first_ids[0]
    assert tasks[0].name == "unregistered file: runs/stray.h5"
    assert tasks[0].extra == {
        "path": "runs/stray.h5",
        "size_bytes": file_stat.st_size,
        "mtime_ns": file_stat.st_mtime_ns,
    }

    replay_ids = scan_storage(session, tmp_path)

    assert replay_ids == first_ids
    assert len(_review_tasks(session)) == 1
    created_events = [
        event
        for event in list_events(session, limit=1000)
        if event["action"] == "created" and event["entity_id"] == first_ids[0]
    ]
    assert len(created_events) == 1


def test_scan_storage_skips_registered_artifact_uri(
    session: Session, tmp_path: Path
) -> None:
    data_path = tmp_path / "runs" / "claimed.h5"
    data_path.parent.mkdir()
    data_path.write_bytes(b"cataloged")
    create_entity(
        session,
        "artifact",
        {"name": "claimed", "uri": "runs/claimed.h5"},
    )

    assert scan_storage(session, tmp_path) == []
    assert _review_tasks(session) == []


def test_scan_storage_skips_dotfiles_and_temporary_files(
    session: Session, tmp_path: Path
) -> None:
    (tmp_path / ".hidden").write_bytes(b"hidden")
    (tmp_path / "in-progress.tmp").write_bytes(b"temporary")
    (tmp_path / "transfer.partial").write_bytes(b"partial")

    assert scan_storage(session, tmp_path) == []
    assert _review_tasks(session) == []


def test_scan_storage_replaced_file_creates_new_review_task(
    session: Session, tmp_path: Path
) -> None:
    data_path = tmp_path / "stray.dat"
    data_path.write_bytes(b"first")
    first_ids = scan_storage(session, tmp_path)

    data_path.write_bytes(b"longer replacement")
    replacement_ids = scan_storage(session, tmp_path)

    assert len(first_ids) == 1
    assert len(replacement_ids) == 1
    assert replacement_ids != first_ids
    assert len(_review_tasks(session)) == 2

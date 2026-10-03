from __future__ import annotations

import logging
import math
import time
import uuid
from pathlib import Path

from sqlmodel import Session, select

from app.config import Settings
from labcore.db import make_engine
from labcore.models.entities import Artifact, ReviewTask
from labcore.service import create_entity, update_entity

logger = logging.getLogger(__name__)

DEFAULT_AGE_GRACE_SECONDS = 60.0


def _canonical_relative_uri(storage_root: Path, uri: str) -> str | None:
    try:
        uri_path = Path(uri)
        if uri_path.is_absolute():
            return None
        relative_path = (storage_root / uri_path).resolve().relative_to(
            storage_root
        )
    except (OSError, RuntimeError, TypeError, ValueError):
        return None
    if relative_path == Path("."):
        return None
    return relative_path.as_posix()


def _registered_artifact_uris(
    session: Session, storage_root: Path
) -> set[str]:
    artifact_uris: set[str] = set()
    for uri in session.exec(select(Artifact.uri)).all():
        canonical_uri = _canonical_relative_uri(storage_root, uri)
        if canonical_uri is not None:
            artifact_uris.add(canonical_uri)
    return artifact_uris


def _reconcile_review_tasks(
    session: Session, storage_root: Path, artifact_uris: set[str]
) -> None:
    if not artifact_uris:
        return
    open_tasks = session.exec(
        select(ReviewTask).where(
            ReviewTask.kind == "unregistered_file",
            ReviewTask.status == "open",
        )
    ).all()
    for task in open_tasks:
        task_path = task.extra.get("path")
        if not isinstance(task_path, str):
            continue
        canonical_uri = _canonical_relative_uri(storage_root, task_path)
        if canonical_uri in artifact_uris:
            update_entity(
                session,
                task.id,
                {"status": "resolved"},
                expect_type="review_task",
            )


def scan_storage(
    session: Session,
    storage_root: Path,
    *,
    age_grace_seconds: float = 0.0,
) -> list[uuid.UUID]:
    if not math.isfinite(age_grace_seconds) or age_grace_seconds < 0:
        raise ValueError("age_grace_seconds must be finite and non-negative")

    storage_root = storage_root.resolve()
    grace_ns = int(age_grace_seconds * 1_000_000_000)
    # One snapshot for the whole scan: reloading every artifact URI per file
    # made the scan O(files x artifacts). Registrations that land mid-scan
    # are caught by the final reconcile pass or the next scan.
    artifact_uris = _registered_artifact_uris(session, storage_root)
    _reconcile_review_tasks(session, storage_root, artifact_uris)
    review_task_ids: list[uuid.UUID] = []

    for path in sorted(storage_root.rglob("*")):
        if not path.is_file():
            continue
        relative_path = path.relative_to(storage_root)
        if any(part.startswith(".") for part in relative_path.parts):
            continue
        if path.suffix in {".tmp", ".partial"}:
            continue

        relative_uri = _canonical_relative_uri(
            storage_root, relative_path.as_posix()
        )
        if relative_uri is None:
            continue

        file_stat = path.stat()
        if time.time_ns() - file_stat.st_mtime_ns < grace_ns:
            continue

        if relative_uri in artifact_uris:
            continue

        review_task = create_entity(
            session,
            "review_task",
            {
                "name": f"unregistered file: {relative_uri}",
                "kind": "unregistered_file",
                "path": relative_uri,
                "size_bytes": file_stat.st_size,
                "mtime_ns": file_stat.st_mtime_ns,
            },
            source_key=(
                f"watcher:{relative_uri}:{file_stat.st_size}:{file_stat.st_mtime_ns}"
            ),
        )
        review_task_ids.append(review_task["id"])

    _reconcile_review_tasks(
        session,
        storage_root,
        _registered_artifact_uris(session, storage_root),
    )
    return review_task_ids


def main() -> None:
    settings = Settings()
    engine = make_engine(settings.db_url)
    with Session(engine) as session:
        review_task_ids = scan_storage(
            session,
            settings.storage_root,
            age_grace_seconds=DEFAULT_AGE_GRACE_SECONDS,
        )
        session.commit()
    logger.info(
        "storage scan complete: %d review tasks encountered",
        len(review_task_ids),
    )


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()

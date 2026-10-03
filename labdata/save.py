from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import uuid
from collections.abc import Iterable, Mapping
from pathlib import Path

import h5py
import httpx
import pyarrow as pa
import pyarrow.parquet as pq

from labdata.client import LabData
from labdata.spool import Spool, SpoolJournalError, is_retryable

logger = logging.getLogger(__name__)

_ARTIFACT_FIELDS = {
    "checksum_sha256",
    "data_format",
    "description",
    "extra",
    "media_type",
    "name",
    "role",
    "schema_version",
    "size_bytes",
    "uri",
}


def save(
    data: object,
    kind: str,
    name: str,
    storage_dir: Path,
    client: LabData,
    spool: Spool,
    producer_id: uuid.UUID | str | None = None,
    related_ids: Iterable[uuid.UUID | str] = (),
    extra: Mapping[str, object] | None = None,
    *,
    subdir: str | Path = "",
) -> dict:
    metadata = dict(extra or {})
    reserved = sorted(_ARTIFACT_FIELDS & metadata.keys())
    if reserved:
        raise ValueError(f"extra keys conflict with artifact fields: {reserved}")

    op_id = uuid.uuid4()
    relative_subdir = Path(subdir)
    if relative_subdir.is_absolute() or ".." in relative_subdir.parts:
        raise ValueError("subdir must be a relative path within storage_dir")

    storage_root = Path(storage_dir).resolve()
    output_dir = (storage_root / relative_subdir).resolve()
    if not output_dir.is_relative_to(storage_root):
        raise ValueError("subdir must be a relative path within storage_dir")
    output_dir.mkdir(parents=True, exist_ok=True)
    filename_root = f"{_slug(name)}-{op_id.hex}"
    if kind == "array":
        suffix = ".h5"
        data_format = "hdf5"
        media_type = "application/x-hdf5"
    elif kind in {"table", "events"}:
        suffix = ".parquet"
        data_format = "parquet"
        media_type = "application/vnd.apache.parquet"
    else:
        raise ValueError(f"unsupported data kind: {kind}")

    path = output_dir / f"{filename_root}{suffix}"
    _write_atomically(path, data, kind)
    checksum_sha256 = _sha256(path)
    source_key = f"labdata:{op_id}"

    artifact_payload = {
        **metadata,
        "name": name,
        "uri": path.relative_to(storage_root).as_posix(),
        "checksum_sha256": checksum_sha256,
        "size_bytes": path.stat().st_size,
        "data_format": data_format,
        "media_type": media_type,
        "role": "raw",
        "schema_version": "1",
    }
    edges = []
    if producer_id is not None:
        edges.append({"relation": "produced_by", "dst_id": str(producer_id)})
    edges.extend(
        {"relation": "refers_to", "dst_id": str(related_id)}
        for related_id in related_ids
    )
    entry = {
        "source_key": source_key,
        "artifact": artifact_payload,
        "edges": edges,
    }

    try:
        journal_path = spool.journal(op_id, entry)
    except Exception as exc:
        # The acquisition already succeeded — a broken spool (disk full,
        # permissions, dead filesystem) must never delete the data. Leave a
        # best-effort recovery sidecar next to the file so the entry can be
        # re-journaled or registered by hand, and surface the failure.
        sidecar: Path | None = path.with_name(f"{path.name}.entry.json")
        try:
            sidecar.write_text(
                json.dumps(entry, sort_keys=True, allow_nan=False),
                encoding="utf-8",
            )
        except (OSError, ValueError):
            logger.exception("could not write recovery sidecar %s", sidecar)
            sidecar = None
        logger.error(
            "spool journal write failed for %s; data preserved at %s", name, path
        )
        raise SpoolJournalError(
            f"spool journal write failed; data preserved at {path}",
            data_path=path,
            sidecar_path=sidecar,
            source_key=source_key,
        ) from exc

    try:
        artifact = client.register_artifact(
            artifact_payload, source_key, links=edges
        )
    except httpx.HTTPError as exc:
        if is_retryable(exc):
            logger.warning(
                "catalog registration deferred for %s: %s", name, exc
            )
            return {
                "pending": True,
                "artifact": None,
                "path": str(path),
                "checksum_sha256": checksum_sha256,
                "source_key": source_key,
                "error": None,
            }
        # Permanent rejection: retrying cannot fix the payload. Dead-letter
        # the journal entry so flush stops replaying it, and surface the
        # error to the caller — without blocking acquisition.
        spool.dead_letter(journal_path, exc)
        return {
            "pending": False,
            "artifact": None,
            "path": str(path),
            "checksum_sha256": checksum_sha256,
            "source_key": source_key,
            "error": str(exc),
        }

    journal_path.unlink(missing_ok=True)
    return {
        "pending": False,
        "artifact": artifact,
        "path": str(path),
        "checksum_sha256": checksum_sha256,
        "source_key": source_key,
        "error": None,
    }


def _slug(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "data"


def _write_atomically(path: Path, data: object, kind: str) -> None:
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        if kind == "array":
            with h5py.File(temporary, "w") as h5:
                h5.create_dataset("data", data=data)
        else:
            table = _as_table(data)
            pq.write_table(table, temporary)
        os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _as_table(data: object) -> pa.Table:
    if isinstance(data, pa.Table):
        return data
    if isinstance(data, dict):
        return pa.table(data)
    raise TypeError("table and events data must be a pyarrow.Table or dict")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

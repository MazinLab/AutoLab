from __future__ import annotations

import json
import logging
import os
import uuid
from pathlib import Path
from typing import cast

import httpx

from labdata.client import LabData

logger = logging.getLogger(__name__)


class SpoolJournalError(RuntimeError):
    """The spool journal could not be written after a completed acquisition.

    The data file is preserved; ``data_path``/``sidecar_path``/``source_key``
    carry everything needed to register the artifact manually or re-journal
    the sidecar once the spool is healthy again.
    """

    def __init__(
        self,
        message: str,
        *,
        data_path: Path,
        sidecar_path: Path | None,
        source_key: str,
    ) -> None:
        super().__init__(message)
        self.data_path = data_path
        self.sidecar_path = sidecar_path
        self.source_key = source_key


class Spool:
    def __init__(self, dir: Path) -> None:
        self.dir = Path(dir)
        self.dir.mkdir(parents=True, exist_ok=True)

    def journal(self, op_id: uuid.UUID, entry: dict) -> Path:
        serialized = json.dumps(
            entry,
            sort_keys=True,
            separators=(",", ":"),
            allow_nan=False,
        )
        path = self.dir / f"{op_id}.json"
        temporary = self.dir / f".{op_id}.{uuid.uuid4().hex}.tmp"
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                stream.write(serialized)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)
        return path

    def pending(self) -> list[Path]:
        return sorted(self.dir.glob("*.json"))

    def dead(self) -> list[Path]:
        return sorted((self.dir / "dead").glob("*.json"))

    def flush(self, client: LabData) -> int:
        completed = 0
        for path in self.pending():
            try:
                entry = self._read(path)
            except (OSError, UnicodeError, ValueError) as exc:
                self._quarantine(path, exc)
                continue
            try:
                client.register_artifact(
                    entry["artifact"],
                    entry["source_key"],
                    links=entry["edges"],
                )
            except httpx.HTTPError as exc:
                if is_retryable(exc):
                    logger.warning(
                        "spool replay failed for %s: %s", path.name, exc
                    )
                else:
                    self.dead_letter(path, exc)
                continue
            path.unlink(missing_ok=True)
            completed += 1
        return completed

    def dead_letter(self, path: Path, error: Exception) -> None:
        """Move a permanently rejected entry to dead/ so it stops retrying
        but stays recoverable (fix the payload, move it back to the spool
        root, flush again)."""
        dead_dir = self.dir / "dead"
        try:
            dead_dir.mkdir(exist_ok=True)
            os.replace(path, dead_dir / path.name)
        except OSError:
            logger.exception(
                "failed to dead-letter rejected spool entry %s", path
            )
            return
        logger.error(
            "catalog permanently rejected spool entry %s: %s", path.name, error
        )

    @staticmethod
    def _read(path: Path) -> dict:
        with path.open(encoding="utf-8") as stream:
            entry = json.load(stream, parse_constant=_reject_nonfinite)
        json.dumps(entry, allow_nan=False)
        if not isinstance(entry, dict):
            raise ValueError("spool entry must be a JSON object")
        if not isinstance(entry.get("artifact"), dict):
            raise ValueError("spool entry artifact must be a JSON object")
        if not isinstance(entry.get("source_key"), str):
            raise ValueError("spool entry source_key must be a string")
        edges = entry.get("edges")
        if not isinstance(edges, list) or not all(
            isinstance(edge, dict)
            and isinstance(edge.get("relation"), str)
            and isinstance(edge.get("dst_id"), str)
            for edge in edges
        ):
            raise ValueError("spool entry edges must be valid JSON objects")
        return cast(dict, entry)

    def _quarantine(self, path: Path, error: Exception) -> None:
        quarantine_dir = self.dir / "quarantine"
        try:
            quarantine_dir.mkdir(exist_ok=True)
            os.replace(path, quarantine_dir / path.name)
        except OSError:
            logger.exception(
                "failed to quarantine malformed spool entry %s", path
            )
            return
        logger.warning(
            "quarantined malformed spool entry %s: %s", path.name, error
        )


def _reject_nonfinite(value: str) -> None:
    raise ValueError(f"non-finite JSON value: {value}")


def is_retryable(error: httpx.HTTPError) -> bool:
    """Transport failures and server-side conditions (5xx, 429) may resolve
    on their own; any other HTTP status is a permanent rejection of this
    payload and retrying cannot fix it."""
    if isinstance(error, httpx.HTTPStatusError):
        code = error.response.status_code
        return code >= 500 or code == 429
    return True

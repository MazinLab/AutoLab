from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import Session, select

from app.importers.elog import import_elog
from labcore.models.base import EntityRegistry


@pytest.mark.parametrize(
    "nonfinite_literal",
    ["NaN", "Infinity", "-Infinity", "1e400"],
)
def test_import_elog_rejects_nested_nonfinite_numbers(
    session: Session,
    tmp_path: Path,
    nonfinite_literal: str,
) -> None:
    entry = {
        "id": "elog-Leiden-1",
        "message_id": 1,
        "logbook": "Leiden",
        "source_url": "https://elog.example/Leiden/1",
        "timestamp": "2020-03-09T14:23:27-07:00",
        "author": "Gregoire Coiffard",
        "subject": "cooldown started",
        "entry_type": "Run Setup",
        "body": "BlueFridge configuration",
        "attributes": {"legacy_value": "NONFINITE"},
        "attachments": [],
        "reply_to": None,
        "thread_id": 1,
        "content_hash": "a" * 64,
    }
    export_path = tmp_path / "nonfinite.jsonl"
    export_path.write_text(
        json.dumps(entry).replace('"NONFINITE"', nonfinite_literal),
        encoding="utf-8",
    )

    with pytest.raises(ValueError, match="invalid JSON|non-finite"):
        import_elog(session, export_path)

    assert session.exec(select(EntityRegistry)).all() == []

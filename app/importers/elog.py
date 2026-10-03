from __future__ import annotations

import argparse
import json
import logging
import math
import uuid
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Sequence

from sqlmodel import Session, select

from app.config import Settings
from labcore.db import make_engine
from labcore.lineage import add_edge
from labcore.models.base import EntityRegistry
from labcore.models.edges import RelationType
from labcore.service import create_entity

logger = logging.getLogger(__name__)

MessageId = int | str

KNOWN_EXPORT_KEYS: frozenset[str] = frozenset(
    {
        "id",
        "message_id",
        "logbook",
        "source_url",
        "timestamp",
        "author",
        "subject",
        "entry_type",
        "body",
        "attributes",
        "attachments",
        "reply_to",
        "thread_id",
        "content_hash",
    }
)


@dataclass(frozen=True)
class ElogEntry:
    elog_id: str
    message_id: MessageId
    logbook: str
    source_url: str
    timestamp: str
    author: str
    subject: str
    entry_type: str
    body: str
    attributes: dict[str, object]
    attachments: list[str]
    reply_to: MessageId | None
    thread_id: MessageId
    content_hash: str
    extra_fields: dict[str, object]


def _validate_finite_numbers(
    value: object, line_number: int, field_path: str = "entry"
) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError(
            f"line {line_number}: {field_path} contains a non-finite number"
        )
    if isinstance(value, dict):
        for key, nested_value in value.items():
            _validate_finite_numbers(
                nested_value,
                line_number,
                f"{field_path}.{key}",
            )
    elif isinstance(value, list):
        for index, nested_value in enumerate(value):
            _validate_finite_numbers(
                nested_value,
                line_number,
                f"{field_path}[{index}]",
            )


def _reject_json_constant(value: str) -> object:
    raise ValueError(f"non-finite JSON number {value!r}")


def _text_field(
    payload: dict[str, object], key: str, line_number: int, *, nonempty: bool = False
) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or (nonempty and not value):
        qualifier = "a nonempty string" if nonempty else "a string"
        raise ValueError(f"line {line_number}: {key} must be {qualifier}")
    return value


def _message_id_field(
    payload: dict[str, object], key: str, line_number: int
) -> MessageId:
    value = payload.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise ValueError(f"line {line_number}: {key} must be an integer or string")
    if value == "":
        raise ValueError(f"line {line_number}: {key} must not be empty")
    return value


def _optional_message_id_field(
    payload: dict[str, object], key: str, line_number: int
) -> MessageId | None:
    if payload.get(key) is None:
        return None
    return _message_id_field(payload, key, line_number)


def _parse_entry(payload: object, line_number: int) -> ElogEntry:
    if not isinstance(payload, dict) or not all(
        isinstance(key, str) for key in payload
    ):
        raise ValueError(f"line {line_number}: entry must be a JSON object")

    entry = dict(payload)
    _validate_finite_numbers(entry, line_number)
    timestamp = _text_field(entry, "timestamp", line_number, nonempty=True)
    try:
        parsed_timestamp = datetime.fromisoformat(timestamp)
    except ValueError as exc:
        raise ValueError(f"line {line_number}: timestamp must be ISO 8601") from exc
    if parsed_timestamp.utcoffset() is None:
        raise ValueError(f"line {line_number}: timestamp must be timezone-aware")

    attributes = entry.get("attributes")
    if not isinstance(attributes, dict) or not all(
        isinstance(key, str) for key in attributes
    ):
        raise ValueError(f"line {line_number}: attributes must be a JSON object")

    attachments = entry.get("attachments")
    if not isinstance(attachments, list) or not all(
        isinstance(url, str) for url in attachments
    ):
        raise ValueError(f"line {line_number}: attachments must be a list of URLs")

    return ElogEntry(
        elog_id=_text_field(entry, "id", line_number, nonempty=True),
        message_id=_message_id_field(entry, "message_id", line_number),
        logbook=_text_field(entry, "logbook", line_number, nonempty=True),
        source_url=_text_field(entry, "source_url", line_number),
        timestamp=timestamp,
        author=_text_field(entry, "author", line_number, nonempty=True),
        subject=_text_field(entry, "subject", line_number),
        entry_type=_text_field(entry, "entry_type", line_number),
        body=_text_field(entry, "body", line_number),
        attributes=dict(attributes),
        attachments=list(attachments),
        reply_to=_optional_message_id_field(entry, "reply_to", line_number),
        thread_id=_message_id_field(entry, "thread_id", line_number),
        content_hash=_text_field(entry, "content_hash", line_number, nonempty=True),
        extra_fields={
            key: value for key, value in entry.items() if key not in KNOWN_EXPORT_KEYS
        },
    )


def _read_entries(path: Path) -> tuple[list[ElogEntry], int]:
    entries: list[ElogEntry] = []
    skipped = 0
    with path.open(encoding="utf-8") as export:
        for line_number, line in enumerate(export, start=1):
            if not line.strip():
                skipped += 1
                continue
            try:
                payload = json.loads(
                    line,
                    parse_constant=_reject_json_constant,
                )
            except (json.JSONDecodeError, ValueError) as exc:
                raise ValueError(f"line {line_number}: invalid JSON") from exc
            entries.append(_parse_entry(payload, line_number))
    return entries, skipped


def _index_entries(
    entries: list[ElogEntry],
) -> tuple[dict[MessageId, ElogEntry], dict[MessageId, str]]:
    entries_by_message_id: dict[MessageId, ElogEntry] = {}
    content_hashes: dict[MessageId, str] = {}
    for entry in entries:
        if entry.message_id in entries_by_message_id:
            raise ValueError(f"duplicate elog message_id: {entry.message_id!r}")
        entries_by_message_id[entry.message_id] = entry
        content_hashes[entry.message_id] = entry.content_hash
    return entries_by_message_id, content_hashes


def _parent_first_entries(
    entries: list[ElogEntry], entries_by_message_id: dict[MessageId, ElogEntry]
) -> tuple[list[ElogEntry], set[MessageId]]:
    """Order entries parent-before-reply, degrading bad thread metadata.

    Legacy elog data contains genuine inconsistencies (the Leiden export has
    messages 75 and 76 replying to each other, and message ids have gaps), so
    a broken thread link must never abort the import: cycles are cut once and
    dangling parents are dropped, both logged, and the affected message ids
    are returned so the caller skips only their thread edges.
    """
    ordered: list[ElogEntry] = []
    visiting: set[MessageId] = set()
    visited: set[MessageId] = set()
    broken: set[MessageId] = set()

    def visit(entry: ElogEntry) -> None:
        if entry.message_id in visited or entry.message_id in visiting:
            return
        visiting.add(entry.message_id)
        if entry.reply_to is not None:
            parent = entries_by_message_id.get(entry.reply_to)
            if parent is None:
                broken.add(entry.message_id)
                logger.warning(
                    "elog message %r replies to missing message %r; "
                    "importing without its thread link",
                    entry.message_id,
                    entry.reply_to,
                )
            elif parent.message_id in visiting:
                # cut the cycle HERE: this entry's parent is an ancestor
                # still being ordered, so ordering it parent-first is
                # impossible — every non-broken entry keeps the guarantee
                # that its parent is created before it.
                broken.add(entry.message_id)
                logger.warning(
                    "cyclic elog reply thread at %r (replies to %r); "
                    "importing without its thread link",
                    entry.message_id,
                    entry.reply_to,
                )
            else:
                visit(parent)
        visiting.remove(entry.message_id)
        visited.add(entry.message_id)
        ordered.append(entry)

    for entry in entries:
        visit(entry)
    return ordered, broken


def _resolve_source_key(session: Session, source_key: str) -> uuid.UUID:
    registry = session.exec(
        select(EntityRegistry).where(EntityRegistry.source_key == source_key)
    ).one_or_none()
    if registry is None:
        raise ValueError(f"no entity found for source_key {source_key!r}")
    return registry.id


def _note_payload(entry: ElogEntry) -> dict[str, object]:
    mapped = {
        "name": entry.subject,
        "body": entry.body,
        "template": entry.entry_type,
        "description": "",
        "elog_id": entry.elog_id,
        "message_id": entry.message_id,
        "logbook": entry.logbook,
        "source_url": entry.source_url,
        "timestamp": entry.timestamp,
        "thread_id": entry.thread_id,
        "reply_to": entry.reply_to,
        "attributes": entry.attributes,
        "attachments": entry.attachments,
    }
    return {**entry.extra_fields, **mapped}


def import_elog(session: Session, path: str | Path) -> dict[str, int]:
    entries, skipped = _read_entries(Path(path))
    entries_by_message_id, content_hashes = _index_entries(entries)
    ordered_entries, broken_threads = _parent_first_entries(
        entries, entries_by_message_id
    )
    people_ids: set[uuid.UUID] = set()

    for entry in ordered_entries:
        try:
            person = create_entity(
                session,
                "person",
                {"name": entry.author},
                source_key=f"elog-person:{entry.author}",
            )
            person_id = person["id"]
            people_ids.add(person_id)

            instrument = create_entity(
                session,
                "instrument",
                {"name": entry.logbook},
                source_key=f"elog-instrument:{entry.logbook}",
            )
            note = create_entity(
                session,
                "note",
                _note_payload(entry),
                actor_id=person_id,
                source_key=f"elog:{entry.content_hash}",
            )
            add_edge(
                session,
                note["id"],
                RelationType.REFERS_TO,
                instrument["id"],
                actor_id=person_id,
            )

            if (
                entry.reply_to is not None
                and entry.message_id not in broken_threads
            ):
                parent_hash = content_hashes[entry.reply_to]
                parent_id = _resolve_source_key(session, f"elog:{parent_hash}")
                add_edge(
                    session,
                    note["id"],
                    RelationType.REFERS_TO,
                    parent_id,
                    actor_id=person_id,
                )
            session.commit()
        except Exception:
            session.rollback()
            raise

    return {
        "notes": len(entries),
        "people": len(people_ids),
        "skipped": skipped,
        "thread_links_skipped": len(broken_threads),
    }


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Import a legacy elog JSONL export")
    parser.add_argument("path", type=Path, help="path to the elog JSONL export")
    args = parser.parse_args(argv)

    settings = Settings()
    engine = make_engine(settings.db_url)
    with Session(engine) as session:
        summary = import_elog(session, args.path)
    logger.info("elog import complete: %s", summary)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    main()

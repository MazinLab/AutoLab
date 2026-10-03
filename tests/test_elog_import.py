from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlmodel import Session, select

from app.importers.elog import import_elog
from labcore.models.base import EntityRegistry
from labcore.models.edges import ProvenanceEdge
from labcore.models.entities import Instrument, Note, Person


def _write_export(path: Path) -> None:
    entries = [
        {
            "id": "elog-Leiden-2",
            "message_id": 2,
            "logbook": "Leiden",
            "source_url": "https://elog.example/Leiden/2",
            "timestamp": "2020-03-10T09:00:00-07:00",
            "author": "Ben Mazin",
            "subject": "re: cooldown started",
            "entry_type": "Experiment",
            "body": "Base temp 21 mK.",
            "attributes": {},
            "attachments": [],
            "reply_to": 1,
            "thread_id": 1,
            "content_hash": "b" * 64,
        },
        {
            "id": "elog-Leiden-1",
            "message_id": 1,
            "logbook": "Leiden",
            "source_url": "https://elog.example/Leiden/1",
            "timestamp": "2020-03-09T14:23:27-07:00",
            "author": "Gregoire Coiffard",
            "subject": "cooldown started",
            "entry_type": "Run Setup",
            "body": "BlueFridge configuration",
            "attributes": {"Run Date": "1583352000"},
            "attachments": ["https://elog.example/Leiden/1/att.png"],
            "reply_to": None,
            "thread_id": 1,
            "content_hash": "a" * 64,
        },
    ]
    path.write_text("\n".join(json.dumps(entry) for entry in entries), encoding="utf-8")


def test_import_elog_is_attributed_linked_and_idempotent(
    session: Session, tmp_path: Path
) -> None:
    export_path = tmp_path / "Leiden.jsonl"
    _write_export(export_path)

    first = import_elog(session, export_path)
    first_edges = session.exec(select(ProvenanceEdge)).all()
    second = import_elog(session, export_path)

    assert first == second == {
        "notes": 2, "people": 2, "skipped": 0, "thread_links_skipped": 0
    }
    notes = session.exec(select(Note)).all()
    assert len(notes) == 2
    notes_by_name = {note.name: note for note in notes}
    parent = notes_by_name["cooldown started"]
    reply = notes_by_name["re: cooldown started"]
    assert parent.template == "Run Setup"
    assert reply.template == "Experiment"
    assert parent.body == "BlueFridge configuration"
    assert parent.description == ""
    assert parent.extra == {
        "elog_id": "elog-Leiden-1",
        "message_id": 1,
        "logbook": "Leiden",
        "source_url": "https://elog.example/Leiden/1",
        "timestamp": "2020-03-09T14:23:27-07:00",
        "thread_id": 1,
        "reply_to": None,
        "attributes": {"Run Date": "1583352000"},
        "attachments": ["https://elog.example/Leiden/1/att.png"],
    }

    people = session.exec(select(Person)).all()
    people_by_name = {person.name: person for person in people}
    assert set(people_by_name) == {"Ben Mazin", "Gregoire Coiffard"}
    registries = {
        registry.id: registry for registry in session.exec(select(EntityRegistry)).all()
    }
    assert registries[parent.id].created_by_id == people_by_name["Gregoire Coiffard"].id
    assert registries[reply.id].created_by_id == people_by_name["Ben Mazin"].id

    instrument = session.exec(select(Instrument)).one()
    assert instrument.name == "Leiden"
    edges = session.exec(select(ProvenanceEdge)).all()
    refers_to = {(edge.src_id, edge.dst_id) for edge in edges}
    assert (parent.id, instrument.id) in refers_to
    assert (reply.id, instrument.id) in refers_to
    assert (reply.id, parent.id) in refers_to
    assert len(edges) == len(first_edges)


def test_import_elog_commits_each_entry(session: Session, tmp_path: Path) -> None:
    export_path = tmp_path / "Leiden.jsonl"
    _write_export(export_path)

    import_elog(session, export_path)

    with Session(session.get_bind()) as independent_session:
        assert len(independent_session.exec(select(Note)).all()) == 2


def test_import_elog_counts_blank_lines_as_skipped(
    session: Session, tmp_path: Path
) -> None:
    export_path = tmp_path / "Leiden.jsonl"
    _write_export(export_path)
    export_path.write_text(
        f"\n{export_path.read_text(encoding='utf-8')}\n\n", encoding="utf-8"
    )

    summary = import_elog(session, export_path)

    assert summary == {
        "notes": 2, "people": 2, "skipped": 2, "thread_links_skipped": 0
    }


@pytest.mark.parametrize(
    ("field", "value", "message"),
    [
        (
            "timestamp",
            "2020-03-10T09:00:00",
            "timestamp must be timezone-aware",
        ),
        (
            "message_id",
            True,
            "message_id must be an integer or string",
        ),
        ("attributes", [], "attributes must be a JSON object"),
        ("attachments", [42], "attachments must be a list of URLs"),
    ],
)
def test_import_elog_rejects_invalid_entry_before_writing(
    session: Session,
    tmp_path: Path,
    field: str,
    value: object,
    message: str,
) -> None:
    export_path = tmp_path / "invalid.jsonl"
    _write_export(export_path)
    entries = [
        json.loads(line)
        for line in export_path.read_text(encoding="utf-8").splitlines()
    ]
    entries[0][field] = value
    export_path.write_text(
        "\n".join(json.dumps(entry) for entry in entries), encoding="utf-8"
    )

    with pytest.raises(ValueError, match=message):
        import_elog(session, export_path)

    assert session.exec(select(EntityRegistry)).all() == []


def test_import_elog_tolerates_missing_reply_parent(
    session: Session, tmp_path: Path
) -> None:
    """A partial export can reference messages outside the export window;
    the entry must import anyway, minus the thread link."""
    export_path = tmp_path / "missing-parent.jsonl"
    _write_export(export_path)
    entries = [
        json.loads(line)
        for line in export_path.read_text(encoding="utf-8").splitlines()
    ]
    entries[0]["reply_to"] = 999
    export_path.write_text(
        "\n".join(json.dumps(entry) for entry in entries), encoding="utf-8"
    )

    summary = import_elog(session, export_path)
    session.commit()

    assert summary["notes"] == len(entries)
    assert summary["thread_links_skipped"] == 1
    registered_notes = [
        r
        for r in session.exec(select(EntityRegistry)).all()
        if r.entity_type == "note"
    ]
    assert len(registered_notes) == len(entries)


def test_import_elog_breaks_mutual_reply_cycles(
    session: Session, tmp_path: Path
) -> None:
    """The real Leiden export contains messages 75<->76 replying to each
    other. Both entries must import; exactly one thread edge survives (the
    cycle is cut once), and the import never aborts."""
    a = {
        "id": "elog-L-75", "message_id": 75, "logbook": "Leiden",
        "source_url": "https://exo/L/75",
        "timestamp": "2021-11-22T10:00:00-08:00", "author": "A",
        "subject": "pump swap", "entry_type": "Maintenance",
        "body": "swap", "attributes": {}, "attachments": [],
        "reply_to": 76, "thread_id": 76, "content_hash": "7" * 64,
    }
    b = {
        **a, "id": "elog-L-76", "message_id": 76,
        "source_url": "https://exo/L/76", "subject": "re: pump swap",
        "reply_to": 75, "thread_id": 75, "content_hash": "8" * 64,
    }
    export_path = tmp_path / "cycle.jsonl"
    export_path.write_text(json.dumps(a) + "\n" + json.dumps(b))

    summary = import_elog(session, export_path)
    session.commit()

    notes = [
        r
        for r in session.exec(select(EntityRegistry)).all()
        if r.entity_type == "note"
    ]
    assert len(notes) == 2, "both cycle members must import"
    note_ids = {n.id for n in notes}
    thread_edges = [
        e
        for e in session.exec(select(ProvenanceEdge)).all()
        if e.relation == "refers_to"
        and e.src_id in note_ids
        and e.dst_id in note_ids
    ]
    assert len(thread_edges) == 1, "the cycle is cut exactly once"
    assert summary["thread_links_skipped"] == 1

    replay = import_elog(session, export_path)
    session.commit()
    assert replay["thread_links_skipped"] == 1  # replay stays a no-op


def test_import_elog_preserves_unknown_export_fields_in_note_extra(
    session: Session, tmp_path: Path
) -> None:
    export_path = tmp_path / "with-extra.jsonl"
    _write_export(export_path)
    entries = [
        json.loads(line)
        for line in export_path.read_text(encoding="utf-8").splitlines()
    ]
    entries[1]["legacy_status"] = {"reviewed": True, "score": 3}
    export_path.write_text(
        "\n".join(json.dumps(entry) for entry in entries), encoding="utf-8"
    )

    import_elog(session, export_path)

    parent = session.exec(
        select(Note).where(Note.name == "cooldown started")
    ).one()
    assert parent.extra["legacy_status"] == {"reviewed": True, "score": 3}

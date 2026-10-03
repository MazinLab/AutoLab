import time
import uuid
from datetime import UTC, datetime, timedelta, timezone

import pytest
from sqlalchemy.exc import IntegrityError, StatementError
from sqlmodel import Session, select

from labcore.models.base import EntityRegistry, uuid7, utcnow


def test_uuid7_is_stdlib_uuid_and_time_ordered() -> None:
    a = uuid7()
    time.sleep(0.002)  # uuid7 ordering is only guaranteed across milliseconds
    b = uuid7()
    assert isinstance(a, uuid.UUID)
    assert a.version == 7
    assert a.bytes < b.bytes


def test_utcnow_is_timezone_aware() -> None:
    assert utcnow().tzinfo is not None


def test_registry_normalizes_non_utc_timestamp_on_roundtrip(session: Session) -> None:
    local_time = datetime(
        2026, 1, 15, 4, 30, tzinfo=timezone(timedelta(hours=-8))
    )
    row = EntityRegistry(
        entity_type="wafer",
        accession="W-2026-0001",
        created_at=local_time,
    )
    session.add(row)
    session.commit()
    session.expire_all()

    got = session.get(EntityRegistry, row.id)
    assert got is not None
    assert got.created_at == datetime(2026, 1, 15, 12, 30, tzinfo=UTC)


def test_registry_rejects_naive_timestamp_at_bind_time(session: Session) -> None:
    row = EntityRegistry(
        entity_type="wafer",
        accession="W-2026-0001",
        created_at=datetime(2026, 1, 15, 12, 30),
    )
    session.add(row)
    with pytest.raises(StatementError, match="naive datetime rejected"):
        session.commit()
    session.rollback()


def test_registry_row_roundtrip_preserves_utc(session: Session) -> None:
    row = EntityRegistry(entity_type="wafer", accession="W-2026-0001")
    session.add(row)
    session.commit()
    session.expire_all()  # force a real DB read, not identity-map echo
    got = session.exec(
        select(EntityRegistry).where(EntityRegistry.accession == "W-2026-0001")
    ).one()
    assert got.entity_type == "wafer"
    assert got.id.version == 7
    assert got.created_by_id is None
    assert got.created_at.tzinfo == UTC  # UTCDateTime round-trips aware


def test_foreign_keys_are_enforced(session: Session) -> None:
    bogus = EntityRegistry(
        entity_type="wafer", accession="W-2026-0002", created_by_id=uuid.uuid4()
    )
    session.add(bogus)
    with pytest.raises(IntegrityError):  # fires on SQLite too (PRAGMA)
        session.commit()
    session.rollback()

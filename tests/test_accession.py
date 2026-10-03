import pytest
from sqlmodel import Session

from labcore.accession import next_accession


def test_first_accession_of_year(session: Session) -> None:
    assert next_accession(session, "wafer", 2026) == "W-2026-0001"


def test_counters_are_independent_per_type_and_year(session: Session) -> None:
    assert next_accession(session, "wafer", 2026) == "W-2026-0001"
    assert next_accession(session, "wafer", 2026) == "W-2026-0002"
    assert next_accession(session, "device", 2026) == "DEV-2026-0001"
    assert next_accession(session, "wafer", 2027) == "W-2027-0001"


def test_unknown_entity_type_raises(session: Session) -> None:
    with pytest.raises(KeyError):
        next_accession(session, "flux_capacitor", 2026)

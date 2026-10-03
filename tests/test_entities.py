from sqlmodel import Session

from labcore.accession import PREFIXES
from labcore.models.base import EntityRegistry
from labcore.models.entities import ENTITY_TYPES, Wafer


def test_entity_types_cover_all_prefixes() -> None:
    assert set(ENTITY_TYPES) == set(PREFIXES)


def test_wafer_roundtrip_with_registry(session: Session) -> None:
    reg = EntityRegistry(entity_type="wafer", accession="W-2026-0001")
    session.add(reg)
    session.flush()
    wafer = Wafer(
        id=reg.id,
        name="Al on Si test wafer",
        material="Al/Si",
        diameter_mm=76.2,
        extra={"lot": "L42"},
    )
    session.add(wafer)
    session.commit()
    got = session.get(Wafer, reg.id)
    assert got is not None
    assert got.extra == {"lot": "L42"}
    assert got.diameter_mm == 76.2


def test_every_entity_table_constructs_and_persists(session: Session) -> None:
    for i, (etype, cls) in enumerate(sorted(ENTITY_TYPES.items())):
        reg = EntityRegistry(entity_type=etype, accession=f"X-2026-{i:04d}")
        session.add(reg)
        session.flush()
        session.add(cls(id=reg.id, name=f"test {etype}"))
    session.commit()

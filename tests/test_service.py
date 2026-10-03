import pytest
from sqlmodel import Session

from labcore.service import (
    UnknownEntityTypeError,
    create_entity,
    get_by_accession,
    get_entity,
    list_entities,
    update_entity,
)


def test_create_generates_accession_and_registry(session: Session) -> None:
    out = create_entity(session, "wafer", {"name": "W1", "material": "Al/Si"})
    assert out["accession"].startswith("W-")
    assert out["entity_type"] == "wafer"
    assert out["material"] == "Al/Si"


def test_unknown_payload_keys_land_in_extra(session: Session) -> None:
    out = create_entity(
        session, "wafer", {"name": "W1", "resist_batch": "AZ300-7"}
    )
    assert out["extra"] == {"resist_batch": "AZ300-7"}


def test_get_by_id_and_accession_agree(session: Session) -> None:
    out = create_entity(session, "device", {"name": "D1"})
    by_id = get_entity(session, out["id"])
    by_acc = get_by_accession(session, out["accession"])
    assert by_id == by_acc == out


def test_update_patches_typed_and_extra_fields(session: Session) -> None:
    out = create_entity(session, "wafer", {"name": "W1"})
    updated = update_entity(
        session, out["id"], {"material": "Nb", "oven_slot": 3}
    )
    assert updated is not None
    assert updated["material"] == "Nb"
    assert updated["extra"]["oven_slot"] == 3


@pytest.mark.parametrize(
    ("field", "value"),
    [("accession", "W-9999-0001"), ("source_key", "replacement")],
)
def test_update_rejects_identity_fields(
    session: Session, field: str, value: str
) -> None:
    out = create_entity(session, "wafer", {"name": "W1"})
    with pytest.raises(ValueError):
        update_entity(session, out["id"], {field: value})


def test_unknown_entity_type_raises(session: Session) -> None:
    with pytest.raises(UnknownEntityTypeError):
        create_entity(session, "flux_capacitor", {"name": "x"})


def test_actor_attribution(session: Session) -> None:
    agent = create_entity(session, "agent", {"name": "fable"})
    wafer = create_entity(
        session, "wafer", {"name": "W1"}, actor_id=agent["id"]
    )
    assert wafer["created_by_id"] == agent["id"]
    assert agent["created_by_id"] is None


def test_unknown_actor_rejected(session: Session) -> None:
    import uuid

    with pytest.raises(ValueError):
        create_entity(session, "wafer", {"name": "W1"}, actor_id=uuid.uuid4())


def test_non_person_actor_rejected(session: Session) -> None:
    wafer = create_entity(session, "wafer", {"name": "W1"})
    with pytest.raises(ValueError):  # a wafer cannot be an actor
        create_entity(session, "device", {"name": "D1"}, actor_id=wafer["id"])


def test_update_with_wrong_expect_type_mutates_nothing(session: Session) -> None:
    wafer = create_entity(session, "wafer", {"name": "W1", "material": "Al"})
    out = update_entity(
        session, wafer["id"], {"material": "Nb"}, expect_type="device"
    )
    assert out is None
    unchanged = get_entity(session, wafer["id"])
    assert unchanged is not None
    assert unchanged["material"] == "Al"
    assert unchanged["updated_at"] == wafer["updated_at"]


def test_list_entities(session: Session) -> None:
    for i in range(3):
        create_entity(session, "device", {"name": f"device {i}"})
    assert len(list_entities(session, "device")) == 3

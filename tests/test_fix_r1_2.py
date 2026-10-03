from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from labcore.service import create_entity, update_entity


def test_service_coerces_typed_values_and_preserves_extra(
    session: Session,
) -> None:
    cooldown = create_entity(
        session,
        "experiment_setup",
        {
            "started_at": "2026-07-18T01:00:00+01:00",
            "base_temp_mk": "85.5",
            "thermometer": "RuOx",
        },
    )

    assert cooldown["started_at"] == datetime(2026, 7, 18, tzinfo=UTC)
    assert cooldown["base_temp_mk"] == 85.5
    assert isinstance(cooldown["base_temp_mk"], float)
    assert cooldown["extra"] == {"thermometer": "RuOx"}

    updated = update_entity(
        session,
        cooldown["id"],
        {
            "ended_at": "2026-07-18T02:00:00+00:00",
            "operator_note": "stable",
        },
    )

    assert updated is not None
    assert updated["ended_at"] == datetime(2026, 7, 18, 2, tzinfo=UTC)
    assert updated["extra"] == {
        "thermometer": "RuOx",
        "operator_note": "stable",
    }


def test_service_validates_required_fields_and_partial_updates(
    session: Session,
) -> None:
    with pytest.raises(ValueError, match="step_index"):
        create_entity(session, "fab_step", {"step_index": "NaN"})

    fab_step = create_entity(session, "fab_step", {"step_index": "2"})
    assert fab_step["accession"].endswith("-0001")
    assert fab_step["step_index"] == 2

    updated = update_entity(
        session, fab_step["id"], {"recipe": "descum"}
    )
    assert updated is not None
    assert updated["recipe"] == "descum"
    assert updated["step_index"] == 2


@pytest.mark.parametrize(
    ("entity_type", "payload", "message"),
    [
        ("wafer", {"diameter_mm": "not-a-number"}, "diameter_mm"),
        ("wafer", {"diameter_mm": "NaN"}, "finite"),
        ("experiment_setup", {"started_at": "not-a-date"}, "started_at"),
        (
            "experiment_setup",
            {"started_at": "2026-07-18T00:00:00"},
            "timezone-aware",
        ),
    ],
)
def test_service_rejects_invalid_typed_values(
    session: Session,
    entity_type: str,
    payload: dict,
    message: str,
) -> None:
    with pytest.raises(ValueError, match=message):
        create_entity(session, entity_type, payload)


def test_api_create_and_update_coerce_datetimes(client: TestClient) -> None:
    created = client.post(
        "/api/experiment_setup",
        json={
            "started_at": "2026-07-18T01:00:00+01:00",
            "thermometer": "RuOx",
        },
    )
    assert created.status_code == 201
    body = created.json()
    assert datetime.fromisoformat(body["started_at"]) == datetime(
        2026, 7, 18, tzinfo=UTC
    )
    assert body["extra"] == {"thermometer": "RuOx"}

    patched = client.patch(
        f"/api/experiment_setup/{body['id']}",
        json={
            "ended_at": "2026-07-18T02:00:00+00:00",
            "operator_note": "stable",
        },
    )
    assert patched.status_code == 200
    patched_body = patched.json()
    assert datetime.fromisoformat(patched_body["ended_at"]) == datetime(
        2026, 7, 18, 2, tzinfo=UTC
    )
    assert patched_body["extra"] == {
        "thermometer": "RuOx",
        "operator_note": "stable",
    }


def test_api_coerces_numeric_strings_before_storage(client: TestClient) -> None:
    created = client.post("/api/wafer", json={"diameter_mm": "100"})
    assert created.status_code == 201
    assert created.json()["diameter_mm"] == 100.0

    fetched = client.get(f"/api/wafer/{created.json()['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["diameter_mm"] == 100.0


def test_api_rejects_invalid_update_without_partial_mutation(
    client: TestClient,
) -> None:
    created = client.post(
        "/api/experiment_setup", json={"base_temp_mk": 85.0}
    ).json()

    response = client.patch(
        f"/api/experiment_setup/{created['id']}",
        json={"base_temp_mk": "90", "ended_at": "not-a-date"},
    )
    assert response.status_code == 422

    fetched = client.get(f"/api/experiment_setup/{created['id']}")
    assert fetched.status_code == 200
    assert fetched.json()["base_temp_mk"] == 85.0
    assert fetched.json()["ended_at"] is None


@pytest.mark.parametrize(
    ("entity_type", "payload"),
    [
        ("fab_step", {"step_index": "not-a-number"}),
        ("wafer", {"diameter_mm": "not-a-number"}),
        ("wafer", {"diameter_mm": "NaN"}),
        ("experiment_setup", {"started_at": "not-a-date"}),
        ("experiment_setup", {"started_at": "2026-07-18T00:00:00"}),
    ],
)
def test_api_rejects_invalid_typed_values(
    client: TestClient, entity_type: str, payload: dict
) -> None:
    response = client.post(f"/api/{entity_type}", json=payload)
    assert response.status_code == 422

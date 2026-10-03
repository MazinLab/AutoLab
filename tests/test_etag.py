from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlmodel import Session

from labcore.events import list_events
from labcore.service import (
    StaleVersionError,
    create_entity,
    get_entity,
    update_entity,
)


def test_service_update_bumps_version_and_rejects_stale_write(
    session: Session,
) -> None:
    wafer = create_entity(session, "wafer", {"name": "W1", "material": "Al"})

    updated = update_entity(
        session,
        wafer["id"],
        {"material": "Nb"},
        expected_version=wafer["version"],
    )

    assert updated is not None
    assert updated["version"] == wafer["version"] + 1
    assert updated["updated_at"] > wafer["updated_at"]
    event_count = len(list_events(session))

    with pytest.raises(StaleVersionError):
        update_entity(
            session,
            wafer["id"],
            {"material": "TiN"},
            expected_version=wafer["version"],
        )

    unchanged = get_entity(session, wafer["id"])
    assert unchanged is not None
    assert unchanged["material"] == "Nb"
    assert unchanged["version"] == updated["version"]
    assert unchanged["updated_at"] == updated["updated_at"]
    assert len(list_events(session)) == event_count


@pytest.mark.parametrize(
    "if_match",
    ['"v0"', "v0", 'W/"v0"', "W/v0"],
)
def test_patch_accepts_supported_if_match_forms(
    client: TestClient, if_match: str
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    response = client.patch(
        f"/api/wafer/{wafer['id']}",
        json={"material": "Nb"},
        headers={"If-Match": if_match},
    )

    assert response.status_code == 200
    assert response.json()["version"] == 1
    assert response.headers["etag"] == '"v1"'


def test_get_routes_return_etag(client: TestClient) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    by_id = client.get(f"/api/wafer/{wafer['id']}")
    by_accession = client.get(f"/api/e/{wafer['accession']}")

    assert by_id.json()["version"] == 0
    assert by_id.headers["etag"] == '"v0"'
    assert by_accession.headers["etag"] == '"v0"'


def test_stale_if_match_returns_412_without_mutation(client: TestClient) -> None:
    wafer = client.post(
        "/api/wafer", json={"name": "W1", "material": "Al"}
    ).json()
    original_etag = client.get(
        f"/api/wafer/{wafer['id']}"
    ).headers["etag"]
    first = client.patch(
        f"/api/wafer/{wafer['id']}",
        json={"material": "Nb"},
        headers={"If-Match": original_etag},
    )

    stale = client.patch(
        f"/api/wafer/{wafer['id']}",
        json={"material": "TiN"},
        headers={"If-Match": original_etag},
    )

    assert first.status_code == 200
    assert stale.status_code == 412
    unchanged = client.get(f"/api/wafer/{wafer['id']}")
    assert unchanged.json()["material"] == "Nb"
    assert unchanged.json()["version"] == 1
    assert unchanged.headers["etag"] == first.headers["etag"]


@pytest.mark.parametrize(
    "if_match",
    ["not-an-etag", "", "v", "v-1", '"v0', 'v0"', 'W/"v0"x'],
)
def test_malformed_if_match_is_rejected_without_mutation(
    client: TestClient,
    if_match: str,
) -> None:
    wafer = client.post(
        "/api/wafer", json={"name": "W1", "material": "Al"}
    ).json()

    response = client.patch(
        f"/api/wafer/{wafer['id']}",
        json={"material": "Nb"},
        headers={"If-Match": if_match},
    )

    assert response.status_code == 400
    unchanged = client.get(f"/api/wafer/{wafer['id']}").json()
    assert unchanged["material"] == "Al"
    assert unchanged["version"] == 0


def test_version_is_not_patchable_through_the_entity_api(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    response = client.patch(
        f"/api/wafer/{wafer['id']}",
        json={"version": 99},
    )

    assert response.status_code == 422
    assert "version" in str(response.json()["detail"])
    unchanged = client.get(f"/api/wafer/{wafer['id']}").json()
    assert unchanged["version"] == 0


def test_patch_without_if_match_preserves_last_write_wins(
    client: TestClient,
) -> None:
    wafer = client.post("/api/wafer", json={"name": "W1"}).json()

    first = client.patch(
        f"/api/wafer/{wafer['id']}", json={"material": "Nb"}
    )
    second = client.patch(
        f"/api/wafer/{wafer['id']}", json={"material": "TiN"}
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert second.json()["material"] == "TiN"
    assert second.json()["version"] == 2
    assert second.headers["etag"] == '"v2"'


def test_version_migration_is_sqlite_safe(tmp_path: Path) -> None:
    database_url = f"sqlite:///{tmp_path / 'etag-migration.db'}"
    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    config.attributes["sqlalchemy_url"] = database_url

    command.upgrade(config, "head")

    engine = create_engine(database_url)
    try:
        columns = {
            column["name"]: column
            for column in inspect(engine).get_columns("entity_registry")
        }
        assert columns["version"]["nullable"] is False
        assert str(columns["version"]["default"]) in {"0", "'0'"}
    finally:
        engine.dispose()

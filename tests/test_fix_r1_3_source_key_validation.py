from typing import cast
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from labcore.service import MAX_SOURCE_KEY_LENGTH, create_entity


def test_create_entity_accepts_maximum_source_key(session: Session) -> None:
    source_key = "x" * MAX_SOURCE_KEY_LENGTH

    entity = create_entity(
        session,
        "wafer",
        {"name": "maximum source key"},
        source_key=source_key,
    )

    assert entity["source_key"] == source_key


def test_source_key_is_validated_before_database_access() -> None:
    database = Mock(spec=Session)

    with pytest.raises(ValueError, match="source_key"):
        create_entity(
            cast(Session, database),
            "wafer",
            {"name": "invalid source key"},
            source_key=cast(str, {}),
        )

    assert database.mock_calls == []


@pytest.mark.parametrize(
    "source_key",
    ["", 1, 1.5, True, {}, [], "x" * (MAX_SOURCE_KEY_LENGTH + 1)],
)
def test_create_entity_rejects_invalid_source_keys(
    session: Session, source_key: object
) -> None:
    with pytest.raises(ValueError, match="source_key"):
        create_entity(
            session,
            "wafer",
            {"name": "invalid source key"},
            source_key=source_key,
        )


@pytest.mark.parametrize("source_key", [1, {}, [], ""])
def test_api_returns_422_for_invalid_source_keys(
    client: TestClient, source_key: object
) -> None:
    response = client.post(
        "/api/wafer",
        json={"name": "invalid source key", "source_key": source_key},
    )

    assert response.status_code == 422
    assert "source_key" in response.json()["detail"]

"""Subscription CRUD and sender-initiated notify endpoints."""

from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session, select

from app.config import Settings
from app.main import create_app
from labcore.models import NotificationOutbox
from labcore.service import create_entity
from tests.test_identity import IDENTITY_ON


def _person(client: TestClient, name: str = "Sub Scriber") -> dict:
    return client.post("/api/person", json={"name": name}).json()


def test_subscription_crud_round_trip(client: TestClient) -> None:
    person = _person(client)
    created = client.post(
        "/api/subscriptions",
        json={
            "person_id": person["id"],
            "entity_type": "wafer",
            "filters": {"material": "NbTiN"},
        },
    )
    assert created.status_code == 201
    sub = created.json()
    assert sub["action"] == "created"
    assert sub["filters"] == {"material": "NbTiN"}

    listed = client.get(
        "/api/subscriptions", params={"person_id": person["id"]}
    ).json()
    assert [s["id"] for s in listed] == [sub["id"]]

    assert (
        client.delete(f"/api/subscriptions/{sub['id']}").status_code == 204
    )
    assert (
        client.get(
            "/api/subscriptions", params={"person_id": person["id"]}
        ).json()
        == []
    )


def test_subscription_validation(client: TestClient) -> None:
    person = _person(client)
    base = {"person_id": person["id"]}
    assert (
        client.post(
            "/api/subscriptions", json={**base, "entity_type": "gizmo"}
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/subscriptions",
            json={**base, "entity_type": "wafer", "action": "exploded"},
        ).status_code
        == 422
    )
    wafer = client.post("/api/wafer", json={"name": "not a person"}).json()
    assert (
        client.post(
            "/api/subscriptions",
            json={"person_id": wafer["id"], "entity_type": "wafer"},
        ).status_code
        == 422
    )


def test_subscription_person_defaults_from_identity(engine: Engine) -> None:
    with Session(engine) as session:
        me = create_entity(
            session,
            "person",
            {"name": "Ben", "tailscale_login": "ben@github"},
        )
        session.commit()
    with TestClient(
        create_app(engine, settings=Settings(**IDENTITY_ON))
    ) as client:
        created = client.post(
            "/api/subscriptions",
            headers={"Tailscale-User-Login": "ben@github"},
            json={"entity_type": "wafer"},
        )
        assert created.status_code == 201
        assert created.json()["person_id"] == str(me["id"])
        # No identity and no explicit person: nothing to attach to.
        anonymous = client.post(
            "/api/subscriptions", json={"entity_type": "wafer"}
        )
        assert anonymous.status_code == 422


def test_notify_enqueues_rows_and_records_event(
    engine: Engine,
) -> None:
    with TestClient(create_app(engine)) as client:
        alice = _person(client, "Alice")
        bob = _person(client, "Bob")
        wafer = client.post("/api/wafer", json={"name": "ready"}).json()
        response = client.post(
            "/api/notify",
            json={
                "person_ids": [alice["id"], bob["id"]],
                "entity_id": wafer["id"],
                "note": "your wafer is ready",
            },
            headers={"X-Actor-Id": alice["id"]},
        )
        assert response.status_code == 202
        assert response.json() == {"queued": 2}

        events = client.get(
            f"/api/entities/{wafer['id']}/events"
        ).json()["events"]
        notified = [e for e in events if e["action"] == "notified"]
        assert len(notified) == 1
        assert set(notified[0]["payload"]["recipient_ids"]) == {
            alice["id"],
            bob["id"],
        }
    with Session(engine) as session:
        rows = session.exec(select(NotificationOutbox)).all()
        assert len(rows) == 2
        assert all("ready" in row.text for row in rows)
        assert all("your wafer is ready" in row.text for row in rows)


def test_notify_validates_recipients_and_entity(client: TestClient) -> None:
    person = _person(client)
    wafer = client.post("/api/wafer", json={"name": "W"}).json()
    assert (
        client.post(
            "/api/notify",
            json={"person_ids": [], "entity_id": wafer["id"]},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/notify",
            json={"person_ids": [wafer["id"]], "entity_id": wafer["id"]},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/api/notify",
            json={
                "person_ids": [person["id"]],
                "entity_id": "01900000-0000-7000-8000-00000000dead",
            },
        ).status_code
        == 404
    )

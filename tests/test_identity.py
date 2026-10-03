"""Tailscale serve identity: default attribution, acting-as, submitted_by.

The trust model is a lab notebook signature, not access control: the
resolved network identity supplies the DEFAULT actor and is recorded as
metadata when someone deliberately acts as another person. Nothing is
rejected based on it.
"""

from __future__ import annotations

import shutil
import socketserver
import tempfile
import threading
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session

import app.identity as identity_module
from app.config import Settings
from app.main import create_app
from labcore.service import create_entity, update_entity

IDENTITY_ON = {
    "identity_mode": "tailscale-serve",
    # starlette's TestClient presents "testclient" as the peer host
    "identity_trusted_proxies": ("testclient",),
}


class FakeTailscaled:
    """Minimal tailscaled localapi: answers whois for one known address."""

    KNOWN_IP = "100.64.0.2"

    def __init__(self, socket_path: Path) -> None:
        self.socket_path = str(socket_path)
        self.requests: list[str] = []
        fake = self

        class Handler(socketserver.StreamRequestHandler):
            def handle(self) -> None:
                request_line = self.rfile.readline().decode()
                while self.rfile.readline() not in (b"\r\n", b"\n", b""):
                    pass  # drain headers
                fake.requests.append(request_line.strip())
                if f"addr={FakeTailscaled.KNOWN_IP}" in request_line:
                    body = b'{"UserProfile": {"LoginName": "ben@github"}}'
                    status = b"HTTP/1.1 200 OK\r\n"
                else:
                    body = b'{"error": "no match for IP"}'
                    status = b"HTTP/1.1 404 Not Found\r\n"
                self.wfile.write(
                    status
                    + b"Content-Type: application/json\r\n"
                    + b"Content-Length: %d\r\n\r\n" % len(body)
                    + body
                )

        self.server = socketserver.ThreadingUnixStreamServer(
            self.socket_path, Handler
        )
        self.thread = threading.Thread(
            target=self.server.serve_forever, daemon=True
        )
        self.thread.start()

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture()
def whois() -> Iterator[FakeTailscaled]:
    # Not tmp_path: AF_UNIX socket paths are capped at ~104 chars on macOS
    # and pytest's tmp_path routinely exceeds that.
    workdir = Path(tempfile.mkdtemp(prefix="ts-whois-"))
    identity_module._whois_cache.clear()
    fake = FakeTailscaled(workdir / "tailscaled.sock")
    yield fake
    fake.stop()
    shutil.rmtree(workdir, ignore_errors=True)
    identity_module._whois_cache.clear()


def _whois_settings(fake: FakeTailscaled) -> Settings:
    return Settings(
        identity_mode="tailscale-whois",
        identity_trusted_proxies=("testclient",),
        identity_whois_socket=fake.socket_path,
    )


def _mapped_person(engine: Engine, login: str = "ben@github") -> dict:
    with Session(engine) as session:
        person = create_entity(
            session,
            "person",
            {"name": "Ben Mazin", "tailscale_login": login},
        )
        session.commit()
    return person


def test_whoami_reports_unresolved_when_mode_off(engine: Engine) -> None:
    with TestClient(create_app(engine)) as client:
        out = client.get(
            "/api/whoami", headers={"Tailscale-User-Login": "ben@github"}
        ).json()
    assert out["login"] is None
    assert out["mapped"] is False
    assert out["can_write"] is True


def test_whoami_ignores_header_from_untrusted_peer(engine: Engine) -> None:
    settings = Settings(identity_mode="tailscale-serve")  # default proxies
    with TestClient(create_app(engine, settings=settings)) as client:
        out = client.get(
            "/api/whoami", headers={"Tailscale-User-Login": "ben@github"}
        ).json()
    assert out["login"] is None


def test_whoami_resolves_mapped_person(engine: Engine) -> None:
    person = _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=Settings(**IDENTITY_ON))
    ) as client:
        out = client.get(
            "/api/whoami", headers={"Tailscale-User-Login": "ben@github"}
        ).json()
    assert out["login"] == "ben@github"
    assert out["mapped"] is True
    assert out["person"]["id"] == str(person["id"])
    assert out["person"]["name"] == "Ben Mazin"


def test_whoami_unmapped_login_prompts_linking(engine: Engine) -> None:
    with TestClient(
        create_app(engine, settings=Settings(**IDENTITY_ON))
    ) as client:
        out = client.get(
            "/api/whoami", headers={"Tailscale-User-Login": "new@github"}
        ).json()
    assert out["login"] == "new@github"
    assert out["person"] is None
    assert out["mapped"] is False


def test_whoami_can_write_reflects_identity_gate(engine: Engine) -> None:
    gated = Settings(**IDENTITY_ON, require_identity_for_writes=True)
    with TestClient(create_app(engine, settings=gated)) as client:
        anonymous = client.get("/api/whoami").json()
        identified = client.get(
            "/api/whoami", headers={"Tailscale-User-Login": "ben@github"}
        ).json()
    assert anonymous["can_write"] is False
    assert identified["can_write"] is True


def test_resolved_identity_is_default_actor_for_writes(engine: Engine) -> None:
    person = _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=Settings(**IDENTITY_ON))
    ) as client:
        wafer = client.post(
            "/api/wafer",
            json={"name": "W1"},
            headers={"Tailscale-User-Login": "ben@github"},
        ).json()
    assert wafer["created_by_id"] == str(person["id"])


def test_explicit_actor_header_overrides_and_records_submitted_by(
    engine: Engine,
) -> None:
    ben = _mapped_person(engine)
    with Session(engine) as session:
        gregoire = create_entity(session, "person", {"name": "Gregoire"})
        session.commit()

    with TestClient(
        create_app(engine, settings=Settings(**IDENTITY_ON))
    ) as client:
        wafer = client.post(
            "/api/wafer",
            json={"name": "joint fab"},
            headers={
                "Tailscale-User-Login": "ben@github",
                "X-Actor-Id": str(gregoire["id"]),
            },
        ).json()
        events = client.get(
            f"/api/entities/{wafer['id']}/events"
        ).json()["events"]

    # attribution is what the caller chose; the event remembers the submitter
    assert wafer["created_by_id"] == str(gregoire["id"])
    created = [e for e in events if e["action"] == "created"]
    assert created[0]["payload"]["submitted_by"] == str(ben["id"])


def test_submitted_by_omitted_when_actor_is_the_submitter(
    engine: Engine,
) -> None:
    _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=Settings(**IDENTITY_ON))
    ) as client:
        wafer = client.post(
            "/api/wafer",
            json={"name": "solo"},
            headers={"Tailscale-User-Login": "ben@github"},
        ).json()
        events = client.get(
            f"/api/entities/{wafer['id']}/events"
        ).json()["events"]
    created = [e for e in events if e["action"] == "created"]
    assert "submitted_by" not in created[0]["payload"]


def test_writes_without_any_identity_stay_anonymous(engine: Engine) -> None:
    with TestClient(
        create_app(engine, settings=Settings(**IDENTITY_ON))
    ) as client:
        wafer = client.post("/api/wafer", json={"name": "anon"}).json()
    assert wafer["created_by_id"] is None


def test_whois_mode_resolves_tailnet_client_to_mapped_person(
    engine: Engine, whois: FakeTailscaled
) -> None:
    person = _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=_whois_settings(whois))
    ) as client:
        out = client.get(
            "/api/whoami", headers={"X-Forwarded-For": "100.64.0.2"}
        ).json()
    assert out["login"] == "ben@github"
    assert out["mapped"] is True
    assert out["person"]["id"] == str(person["id"])


def test_whois_mode_is_default_actor_for_writes_and_caches(
    engine: Engine, whois: FakeTailscaled
) -> None:
    person = _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=_whois_settings(whois))
    ) as client:
        first = client.post(
            "/api/wafer",
            json={"name": "W1"},
            headers={"X-Forwarded-For": "100.64.0.2"},
        ).json()
        second = client.post(
            "/api/wafer",
            json={"name": "W2"},
            headers={"X-Forwarded-For": "100.64.0.2"},
        ).json()
    assert first["created_by_id"] == str(person["id"])
    assert second["created_by_id"] == str(person["id"])
    # one whois round trip; the second write hit the cache
    assert len(whois.requests) == 1


def test_whois_mode_ignores_forged_serve_header(
    engine: Engine, whois: FakeTailscaled
) -> None:
    _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=_whois_settings(whois))
    ) as client:
        out = client.get(
            "/api/whoami", headers={"Tailscale-User-Login": "ben@github"}
        ).json()
    assert out["login"] is None


def test_whois_mode_consults_only_the_proxy_appended_hop(
    engine: Engine, whois: FakeTailscaled
) -> None:
    """A client-forged tailnet prefix must not resolve: the trustworthy
    entry is the LAST one, appended by our own reverse proxy."""
    _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=_whois_settings(whois))
    ) as client:
        out = client.get(
            "/api/whoami",
            headers={"X-Forwarded-For": "100.64.0.2, 128.111.23.5"},
        ).json()
    assert out["login"] is None
    assert whois.requests == []  # campus address: whois never consulted


def test_whois_mode_unknown_tailnet_peer_is_unresolved(
    engine: Engine, whois: FakeTailscaled
) -> None:
    with TestClient(
        create_app(engine, settings=_whois_settings(whois))
    ) as client:
        out = client.get(
            "/api/whoami", headers={"X-Forwarded-For": "100.64.0.77"}
        ).json()
    assert out["login"] is None
    assert out["mapped"] is False


def test_whois_mode_untrusted_peer_never_reaches_whois(
    engine: Engine, whois: FakeTailscaled
) -> None:
    settings = Settings(
        identity_mode="tailscale-whois",
        identity_whois_socket=whois.socket_path,
    )  # default trusted proxies exclude the test client
    with TestClient(create_app(engine, settings=settings)) as client:
        out = client.get(
            "/api/whoami", headers={"X-Forwarded-For": "100.64.0.2"}
        ).json()
    assert out["login"] is None
    assert whois.requests == []


def test_whois_mode_survives_dead_tailscaled_socket(
    engine: Engine, tmp_path: Path
) -> None:
    identity_module._whois_cache.clear()
    settings = Settings(
        identity_mode="tailscale-whois",
        identity_trusted_proxies=("testclient",),
        identity_whois_socket=str(tmp_path / "absent.sock"),
    )
    with TestClient(create_app(engine, settings=settings)) as client:
        out = client.get(
            "/api/whoami", headers={"X-Forwarded-For": "100.64.0.2"}
        ).json()
        wafer = client.post(
            "/api/wafer",
            json={"name": "anon"},
            headers={"X-Forwarded-For": "100.64.0.2"},
        ).json()
    assert out["login"] is None
    assert wafer["created_by_id"] is None
    identity_module._whois_cache.clear()


def _readonly_settings(fake: FakeTailscaled) -> Settings:
    return Settings(
        identity_mode="tailscale-whois",
        identity_trusted_proxies=("testclient",),
        identity_whois_socket=fake.socket_path,
        require_identity_for_writes=True,
    )


def test_require_identity_rejects_anonymous_writes(
    engine: Engine, whois: FakeTailscaled
) -> None:
    """Campus users behind the shared proxy password are read only: no
    resolved tailnet identity, no writes — X-Actor-Id cannot bypass it."""
    with TestClient(
        create_app(engine, settings=_readonly_settings(whois))
    ) as client:
        campus = client.post(
            "/api/wafer",
            json={"name": "drive-by"},
            headers={"X-Forwarded-For": "128.111.23.5"},
        )
        forged_actor = client.post(
            "/api/wafer",
            json={"name": "forged"},
            headers={
                "X-Forwarded-For": "128.111.23.5",
                "X-Actor-Id": "01900000-0000-7000-8000-000000000001",
            },
        )
        wafers = client.get("/api/wafer").json()
    assert campus.status_code == 403
    assert "read-only" in campus.json()["detail"]
    assert forged_actor.status_code == 403
    assert wafers == []


def test_require_identity_allows_identified_tailnet_writes(
    engine: Engine, whois: FakeTailscaled
) -> None:
    person = _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=_readonly_settings(whois))
    ) as client:
        wafer = client.post(
            "/api/wafer",
            json={"name": "W1"},
            headers={"X-Forwarded-For": "100.64.0.2"},
        )
    assert wafer.status_code == 201
    assert wafer.json()["created_by_id"] == str(person["id"])


def test_require_identity_keeps_reads_open(
    engine: Engine, whois: FakeTailscaled
) -> None:
    with TestClient(
        create_app(engine, settings=_readonly_settings(whois))
    ) as client:
        health = client.get("/api/health")
        whoami = client.get(
            "/api/whoami", headers={"X-Forwarded-For": "128.111.23.5"}
        )
    assert health.status_code == 200
    out = whoami.json()
    assert out["login"] is None
    # The write gate is on: an unresolved campus caller must see can_write
    # False so the UI reports read-only honestly.
    assert out["can_write"] is False


def test_require_identity_blocks_anonymous_mcp_posts(
    engine: Engine, whois: FakeTailscaled
) -> None:
    """MCP speaks POST for everything; anonymous callers lose the whole
    endpoint rather than gaining an unattributed write path."""
    with TestClient(
        create_app(engine, settings=_readonly_settings(whois))
    ) as client:
        response = client.post(
            "/mcp",
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            headers={"X-Forwarded-For": "128.111.23.5"},
        )
    assert response.status_code == 403


def test_tailscale_login_must_be_unique_across_people(engine: Engine) -> None:
    _mapped_person(engine)
    with TestClient(create_app(engine)) as client:
        duplicate = client.post(
            "/api/person",
            json={"name": "Imposter", "tailscale_login": "ben@github"},
        )
        other = client.post(
            "/api/person", json={"name": "Other", "tailscale_login": ""}
        )
        collide = client.patch(
            f"/api/person/{other.json()['id']}",
            json={"tailscale_login": "ben@github"},
        )
        relink_self = client.patch(
            f"/api/person/{other.json()['id']}",
            json={"tailscale_login": "other@github"},
        )

    assert duplicate.status_code == 422
    assert "already linked" in duplicate.json()["detail"]
    assert other.status_code == 201
    assert collide.status_code == 422
    assert relink_self.status_code == 200


def test_hybrid_mode_accepts_serve_and_falls_back_to_whois(
    engine: Engine, whois: FakeTailscaled
) -> None:
    person = _mapped_person(engine)
    settings = Settings(
        identity_mode="tailscale-hybrid",
        identity_trusted_proxies=("testclient",),
        identity_whois_socket=whois.socket_path,
    )
    with TestClient(create_app(engine, settings=settings)) as client:
        served = client.get(
            "/api/whoami",
            headers={"Tailscale-User-Login": "ben@github"},
        ).json()
        via_whois = client.get(
            "/api/whoami",
            headers={"X-Forwarded-For": "100.64.0.2"},
        ).json()
    assert served["person"]["id"] == str(person["id"])
    assert via_whois["person"]["id"] == str(person["id"])
    assert len(whois.requests) == 1


def test_person_retains_multiple_network_login_aliases(
    engine: Engine,
) -> None:
    person = _mapped_person(engine, login="bmazin@")
    with Session(engine) as session:
        update_entity(
            session,
            person["id"],
            {"tailscale_login": "personal@example.com"},
        )
        session.commit()

    with TestClient(
        create_app(engine, settings=Settings(**IDENTITY_ON))
    ) as client:
        work = client.get(
            "/api/whoami",
            headers={"Tailscale-User-Login": "bmazin@"},
        ).json()
        personal = client.get(
            "/api/whoami",
            headers={
                "Tailscale-User-Login": "personal@example.com"
            },
        ).json()

    assert work["person"]["id"] == str(person["id"])
    assert personal["person"]["id"] == str(person["id"])


def test_cross_site_upload_from_a_tailnet_browser_is_rejected(
    engine: Engine, whois: FakeTailscaled, tmp_path: Path
) -> None:
    """Identity is the network, not a cookie: a page on another site, opened
    by a tailnet user, must not upload as them. A multipart form POST needs
    no CORS preflight, so only an Origin check stops it."""
    _mapped_person(engine)
    settings = _readonly_settings(whois).model_copy(
        update={"storage_root": tmp_path}
    )
    with TestClient(create_app(engine, settings=settings)) as client:
        upload = client.post(
            "/api/artifacts/upload",
            files={"file": ("x.txt", b"drive-by", "text/plain")},
            headers={
                "X-Forwarded-For": "100.64.0.2",
                "Origin": "https://evil.example",
            },
        )
        sandboxed = client.post(
            "/api/wafer",
            json={"name": "null origin"},
            headers={"X-Forwarded-For": "100.64.0.2", "Origin": "null"},
        )
        artifacts = client.get("/api/artifact").json()
        wafers = client.get("/api/wafer").json()
    assert upload.status_code == 403
    assert "cross-site" in upload.json()["detail"]
    assert sandboxed.status_code == 403
    assert artifacts == [] and wafers == []


def test_same_origin_and_origin_less_writes_pass(
    engine: Engine, whois: FakeTailscaled
) -> None:
    """The app's own pages send a matching Origin (Host, or the proxy's
    X-Forwarded-Host); scripts and instrument PCs send none."""
    _mapped_person(engine)
    with TestClient(
        create_app(engine, settings=_readonly_settings(whois))
    ) as client:
        page = client.post(
            "/api/wafer",
            json={"name": "W1"},
            headers={"X-Forwarded-For": "100.64.0.2", "Origin": "https://testserver"},
        )
        proxied = client.post(
            "/api/wafer",
            json={"name": "W2"},
            headers={
                "X-Forwarded-For": "100.64.0.2",
                "X-Forwarded-Host": "autolab.example.edu",
                "Origin": "https://autolab.example.edu",
            },
        )
        script = client.post(
            "/api/wafer",
            json={"name": "W3"},
            headers={"X-Forwarded-For": "100.64.0.2"},
        )
    assert [page.status_code, proxied.status_code, script.status_code] == [201] * 3

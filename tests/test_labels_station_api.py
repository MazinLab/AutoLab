from __future__ import annotations

import socketserver
import threading
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from app.config import Settings
from app.main import create_app

IDENTITY_ON = {
    "identity_mode": "tailscale-serve",
    "identity_trusted_proxies": ("testclient",),
}
SERVE_HEADER = {"Tailscale-User-Login": "ben@github"}


class _CaptureHandler(socketserver.StreamRequestHandler):
    received: list[bytes] = []

    def handle(self) -> None:
        self.received.append(self.rfile.read())


@pytest.fixture
def printer_port() -> Iterator[int]:
    _CaptureHandler.received = []
    with socketserver.ThreadingTCPServer(("127.0.0.1", 0), _CaptureHandler) as server:
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        yield server.server_address[1]
        server.shutdown()


def _client(engine: Engine, **overrides) -> TestClient:
    return TestClient(create_app(engine=engine, settings=Settings(**overrides)))


COMPUTER = {
    "template": "computer",
    "fields": {"hostname": "mec", "mac": "aa:bb:cc:dd:ee:ff", "ip": "192.168.254.1"},
}


def test_render_returns_svg_zpl_and_no_problems(engine: Engine) -> None:
    response = _client(engine).post("/api/labels/render", json=COMPUTER)
    assert response.status_code == 200
    data = response.json()
    assert data["svg"].startswith("<svg")
    assert 'viewBox="0 0 406 254"' in data["svg"]
    assert data["zpl"].startswith("^XA")
    assert "^FDAA:BB:CC:DD:EE:FF^FS" in data["zpl"]
    assert data["problems"] == []


def test_render_reports_problems_without_failing(engine: Engine) -> None:
    body = {"template": "computer", "fields": {"hostname": "mec", "mac": "nope", "ip": ""}}
    response = _client(engine).post("/api/labels/render", json=body)
    assert response.status_code == 200
    assert any("MAC" in problem for problem in response.json()["problems"])


def test_render_general_stamps_today_in_lab_timezone(engine: Engine) -> None:
    from datetime import datetime
    from zoneinfo import ZoneInfo

    body = {"template": "general", "fields": {"title": "Box", "body": "x", "url": ""}}
    response = _client(engine, label_timezone="Pacific/Kiritimati").post(
        "/api/labels/render", json=body
    )
    expected = datetime.now(ZoneInfo("Pacific/Kiritimati")).strftime("%m/%d/%y")
    assert f"^FD{expected}^FS" in response.json()["zpl"]


def test_render_with_logo_embeds_the_mark_in_both_outputs(engine: Engine) -> None:
    response = _client(engine).post("/api/labels/render", json={**COMPUTER, "logo": True})
    assert response.status_code == 200
    data = response.json()
    assert "^GFA,2244,2244,17," in data["zpl"]
    assert "data:image/png;base64," in data["svg"]
    assert "^FDMazin Lab^FS" not in data["zpl"]


def test_render_positions_the_logo(engine: Engine) -> None:
    body = {
        "template": "general",
        "fields": {"title": "Box", "body": "x", "url": "https://example.org"},
        "logo": True,
        "logo_position": "bottom_right",
    }
    data = _client(engine).post("/api/labels/render", json=body).json()
    assert "^FO304,158^GFA,968,968,11," in data["zpl"]
    assert "^BQ" in data["zpl"]
    assert data["problems"] == []


@pytest.mark.parametrize(
    "body",
    [
        {**COMPUTER, "logo": True, "logo_position": "top_right"},
        {**COMPUTER, "logo": True, "logo_position": 3},
        {"template": "general", "fields": {}, "logo": True, "logo_position": "middle"},
    ],
)
def test_render_rejects_bad_logo_positions(engine: Engine, body: dict) -> None:
    assert _client(engine).post("/api/labels/render", json=body).status_code == 422


def test_render_without_logo_flag_has_no_graphic(engine: Engine) -> None:
    zpl = _client(engine).post("/api/labels/render", json=COMPUTER).json()["zpl"]
    assert "^GFA" not in zpl


@pytest.mark.parametrize(
    "body",
    [
        {"template": "computer", "fields": {"hostname": "mec"}, "logo": "yes"},
        {"template": "poster", "fields": {}},
        {"template": "computer", "fields": "hostname=mec"},
        {"template": "computer"},
        {"template": "computer", "fields": {"hostname": 7}},
    ],
)
def test_render_rejects_malformed_requests(engine: Engine, body: dict) -> None:
    assert _client(engine).post("/api/labels/render", json=body).status_code == 422


def test_print_sends_zpl_with_copies_to_the_printer(
    engine: Engine, printer_port: int
) -> None:
    client = _client(engine, printers={"bench": f"127.0.0.1:{printer_port}"})
    response = client.post("/api/labels/print", json={**COMPUTER, "copies": 2})
    assert response.status_code == 200
    assert response.json() == {"printer": "bench", "copies": 2}
    for _ in range(50):
        if _CaptureHandler.received:
            break
        threading.Event().wait(0.02)
    zpl = _CaptureHandler.received[0].decode()
    assert "^PQ2" in zpl
    assert "^FDmec^FS" in zpl


def test_print_defaults_to_one_copy_and_named_printer(
    engine: Engine, printer_port: int
) -> None:
    client = _client(
        engine,
        printers={"other": "127.0.0.1:1", "bench": f"127.0.0.1:{printer_port}"},
    )
    response = client.post("/api/labels/print", json={**COMPUTER, "printer": "bench"})
    assert response.status_code == 200
    assert response.json() == {"printer": "bench", "copies": 1}


@pytest.mark.parametrize("copies", [0, 21, "two"])
def test_print_rejects_bad_copies(engine: Engine, copies) -> None:
    client = _client(engine, printers={"bench": "127.0.0.1:1"})
    response = client.post("/api/labels/print", json={**COMPUTER, "copies": copies})
    assert response.status_code == 422


def test_print_without_printers_is_a_client_error(engine: Engine) -> None:
    response = _client(engine).post("/api/labels/print", json=COMPUTER)
    assert response.status_code == 400


def test_print_unreachable_printer_is_502(engine: Engine) -> None:
    client = _client(engine, printers={"bench": "127.0.0.1:1"})
    assert client.post("/api/labels/print", json=COMPUTER).status_code == 502


def test_print_needs_identity_when_the_deployment_requires_it(engine: Engine) -> None:
    client = _client(engine, require_identity_for_writes=True, **IDENTITY_ON)
    assert client.post("/api/labels/render", json=COMPUTER).status_code == 403
    assert client.post("/api/labels/print", json=COMPUTER).status_code == 403
    assert (
        client.post("/api/labels/render", json=COMPUTER, headers=SERVE_HEADER).status_code
        == 200
    )


# ---------------------------------------------------------------------------
# The page itself


@pytest.fixture
def dist(tmp_path):
    (tmp_path / "labels").mkdir()
    (tmp_path / "labels" / "index.html").write_text("<title>Label station</title>")
    (tmp_path / "index.html").write_text("<title>AutoLab</title>")
    return tmp_path


def test_labels_page_is_hidden_without_a_tailnet_login(engine: Engine, dist) -> None:
    client = _client(
        engine, frontend_dist=dist, require_identity_for_writes=True, **IDENTITY_ON
    )
    for path in ("/labels", "/labels/"):
        response = client.get(path)
        assert response.status_code == 404
        assert response.json() == {"detail": "Not Found"}


def test_labels_page_served_to_a_tailnet_login(engine: Engine, dist) -> None:
    client = _client(
        engine, frontend_dist=dist, require_identity_for_writes=True, **IDENTITY_ON
    )
    response = client.get("/labels", headers=SERVE_HEADER)
    assert response.status_code == 200
    assert "Label station" in response.text


def test_labels_page_open_when_identity_is_not_required(engine: Engine, dist) -> None:
    response = _client(engine, frontend_dist=dist).get("/labels/")
    assert response.status_code == 200
    assert "Label station" in response.text


def test_labels_page_503_when_frontend_not_built(engine: Engine, tmp_path) -> None:
    assert _client(engine, frontend_dist=tmp_path).get("/labels").status_code == 503

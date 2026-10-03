from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from app.config import Settings
from app.main import create_app


def test_pwa_root_files_are_served_before_spa_fallback(
    engine: Engine, tmp_path: Path
) -> None:
    frontend_dist = tmp_path / "dist"
    frontend_dist.mkdir()
    (frontend_dist / "index.html").write_text(
        "<!doctype html><title>AutoLab test shell</title>",
        encoding="utf-8",
    )
    (frontend_dist / "sw.js").write_text(
        "self.addEventListener('fetch', () => undefined);",
        encoding="utf-8",
    )
    (frontend_dist / "manifest.webmanifest").write_text(
        '{"name":"AutoLab"}',
        encoding="utf-8",
    )

    app = create_app(engine, Settings(frontend_dist=frontend_dist))
    with TestClient(app) as client:
        service_worker = client.get("/sw.js")
        manifest = client.get("/manifest.webmanifest")
        unknown_route = client.get("/analysis/unknown")

    assert service_worker.status_code == 200
    assert service_worker.text.startswith("self.addEventListener")
    assert not service_worker.headers["content-type"].startswith("text/html")
    assert manifest.status_code == 200
    assert manifest.json() == {"name": "AutoLab"}
    assert not manifest.headers["content-type"].startswith("text/html")
    assert unknown_route.status_code == 200
    assert unknown_route.headers["content-type"].startswith("text/html")
    assert "AutoLab test shell" in unknown_route.text

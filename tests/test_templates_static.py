from pathlib import Path

from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine

from app.config import Settings
from app.main import create_app


def test_templates_are_structurally_valid(client: TestClient) -> None:
    # templates.json is hand-edited data with no type checker of its own:
    # this is the lint pass that catches typo'd keys and invalid field types.
    response = client.get("/api/templates")

    assert response.status_code == 200
    templates = response.json()
    assert templates
    names = [template["name"] for template in templates]
    assert len(names) == len(set(names))
    for template in templates:
        assert template["name"]
        assert template["entity_type"]
        assert template["group"] in {"projects", "fab", "testing", "other"}
        assert isinstance(template["fields"], list)
        assert set(template) <= {
            "name", "entity_type", "group", "defaults", "fields", "body",
            "attachments", "notify", "batch", "start_from",
        }
        for field in template["fields"]:
            assert field["name"]
            assert field["label"]
            assert field["type"] in {
                "text", "number", "datetime", "entity", "select", "results",
            }
            assert set(field) <= {
                "name", "label", "type", "unit", "required", "options", "default",
            }
            if field["type"] == "select":
                assert field["options"] and all(
                    isinstance(option, str) for option in field["options"]
                )
            else:
                assert "options" not in field and "default" not in field


def test_spa_and_assets_are_served_from_configured_dist(
    engine: Engine, tmp_path: Path
) -> None:
    frontend_dist = tmp_path / "dist"
    assets_dir = frontend_dist / "assets"
    assets_dir.mkdir(parents=True)
    (frontend_dist / "index.html").write_text(
        "<!doctype html><title>AutoLab test shell</title>",
        encoding="utf-8",
    )
    (assets_dir / "app.js").write_text(
        "globalThis.autolabLoaded = true;",
        encoding="utf-8",
    )

    app = create_app(engine, Settings(frontend_dist=frontend_dist))
    with TestClient(app) as client:
        root = client.get("/")
        deep_link = client.get("/e/W-2026-0001")
        asset = client.get("/assets/app.js")
        missing_asset = client.get("/assets/missing.js")
        api = client.get("/api/schema")

    assert root.status_code == 200
    assert root.headers["content-type"].startswith("text/html")
    assert "AutoLab test shell" in root.text
    assert deep_link.status_code == 200
    assert "AutoLab test shell" in deep_link.text
    assert asset.status_code == 200
    assert "autolabLoaded" in asset.text
    assert missing_asset.status_code == 404
    assert api.status_code == 200
    assert api.headers["content-type"].startswith("application/json")


def test_missing_frontend_returns_clear_503(
    engine: Engine, tmp_path: Path
) -> None:
    app = create_app(
        engine,
        Settings(frontend_dist=tmp_path / "missing-dist"),
    )
    with TestClient(app) as client:
        root = client.get("/")
        api = client.get("/api/schema")

    assert root.status_code == 503
    assert root.json() == {"detail": "frontend not built"}
    assert api.status_code == 200


def test_frontend_fallback_does_not_capture_unknown_api_routes(
    engine: Engine, tmp_path: Path
) -> None:
    frontend_dist = tmp_path / "dist"
    frontend_dist.mkdir()
    (frontend_dist / "index.html").write_text(
        "<!doctype html><title>AutoLab test shell</title>",
        encoding="utf-8",
    )

    app = create_app(engine, Settings(frontend_dist=frontend_dist))
    with TestClient(app) as client:
        ui_route = client.get("/analysis/wafer")
        unknown_api = client.get("/api/not-a-real-route/with/depth")

    assert ui_route.status_code == 200
    assert "AutoLab test shell" in ui_route.text
    assert unknown_api.status_code == 404
    assert unknown_api.json() == {"detail": "Not Found"}

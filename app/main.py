from fastapi import FastAPI, Request
from fastapi.responses import (
    FileResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from fastapi.staticfiles import StaticFiles
from sqlalchemy.engine import Engine

from app.api.artifacts import router as artifacts_router
from app.api.entities import router as entities_router
from app.api.labels import router as labels_router
from app.api.lineage import router as lineage_router
from app.api.meta import router as meta_router
from app.api.notifications import router as notifications_router
from app.api.projects import router as projects_router
from app.api.results import router as results_router
from app.api.rf import router as rf_router
from app.api.search import router as search_router
from app.config import Settings
from app.body_limit import UploadBodyLimitMiddleware
from app.identity import NetworkIdentityMiddleware, resolve_login
from app.logging_config import setup_logging
from app.mcp.server import create_mcp
from labcore.db import make_engine


def create_app(
    engine: Engine | None = None, settings: Settings | None = None
) -> FastAPI:
    # Runtime schema creation would conceal incomplete migrations, so the
    # application relies exclusively on `alembic upgrade head`.
    settings = settings or Settings()
    setup_logging(settings.log_json)
    if engine is None:
        engine = make_engine(settings.db_url)
    mcp_app = create_mcp(engine, settings).http_app(path="/")
    app = FastAPI(title="AutoLab", lifespan=mcp_app.lifespan)
    app.state.engine = engine
    app.state.settings = settings
    app.add_middleware(NetworkIdentityMiddleware)
    app.add_middleware(UploadBodyLimitMiddleware)
    app.include_router(lineage_router)
    app.include_router(search_router)
    app.include_router(meta_router)
    app.include_router(artifacts_router)
    app.include_router(labels_router)
    app.include_router(notifications_router)
    app.include_router(projects_router)
    app.include_router(rf_router)
    app.include_router(results_router)
    app.include_router(entities_router)
    app.mount("/mcp", mcp_app)

    @app.api_route(
        "/mcp",
        methods=["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
        include_in_schema=False,
    )
    def redirect_to_mcp_mount() -> RedirectResponse:
        return RedirectResponse(url="/mcp/", status_code=307)

    frontend_dist = settings.frontend_dist
    assets_dir = frontend_dist / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/labels", include_in_schema=False)
    @app.get("/labels/", include_in_schema=False)
    def serve_label_station(request: Request) -> Response:
        # The label station is tailnet-only and unlinked: without a resolved
        # login the path does not exist, unless this deployment does not
        # gate writes on identity (dev), where it is simply open.
        if settings.require_identity_for_writes and resolve_login(request) is None:
            return JSONResponse(status_code=404, content={"detail": "Not Found"})
        page = frontend_dist / "labels" / "index.html"
        if not page.is_file():
            return JSONResponse(
                status_code=503, content={"detail": "frontend not built"}
            )
        return FileResponse(page)

    @app.get("/{path:path}", include_in_schema=False)
    def serve_frontend(path: str) -> Response:
        if path in {"api", "mcp"} or path.startswith(("api/", "mcp/")):
            return JSONResponse(status_code=404, content={"detail": "Not Found"})

        frontend_root = frontend_dist.resolve()
        candidate = (frontend_dist / path).resolve()
        try:
            candidate.relative_to(frontend_root)
        except ValueError:
            pass
        else:
            if candidate.is_file():
                return FileResponse(candidate)

        index_path = frontend_dist / "index.html"
        if not index_path.is_file():
            return JSONResponse(
                status_code=503,
                content={"detail": "frontend not built"},
            )
        return FileResponse(index_path)

    return app

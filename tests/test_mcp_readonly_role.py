import asyncio
from pathlib import Path
from unittest.mock import patch

import pytest
from fastmcp import Client
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel

from app.config import Settings
from app.mcp import server
from labcore.db import make_engine
from labcore.service import create_entity


ROOT = Path(__file__).resolve().parents[1]
READONLY_ROLE_SQL = ROOT / "compose" / "initdb" / "01_readonly_role.sql"


def test_query_sql_uses_configured_readonly_engine(
    engine: Engine, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    readonly_engine = make_engine(f"sqlite:///{tmp_path / 'readonly.db'}")
    SQLModel.metadata.create_all(readonly_engine)
    with Session(engine) as session:
        create_entity(session, "wafer", {"name": "primary wafer"})
        session.commit()
    with Session(readonly_engine) as session:
        create_entity(session, "wafer", {"name": "readonly wafer"})
        session.commit()

    configured_url = "sqlite:///configured-readonly.db"
    observed_urls: list[str] = []

    def build_query_engine(url: str) -> Engine:
        observed_urls.append(url)
        return readonly_engine

    monkeypatch.setattr(server, "make_engine", build_query_engine)
    mcp = server.create_mcp(engine, Settings(readonly_db_url=configured_url))

    async def query() -> dict[str, object]:
        async with Client(mcp) as client:
            return (
                await client.call_tool(
                    "query_sql", {"sql": "SELECT name FROM wafer"}
                )
            ).data

    try:
        result = asyncio.run(query())
    finally:
        readonly_engine.dispose()

    assert observed_urls == [configured_url]
    assert result["rows"] == [["readonly wafer"]]


def test_postgres_primary_credentials_emit_warning() -> None:
    postgres_engine = make_engine(
        "postgresql+psycopg://autolab:unused@localhost/autolab"
    )
    try:
        with patch.object(server.logger, "warning") as warning:
            server.create_mcp(postgres_engine, Settings())
    finally:
        postgres_engine.dispose()

    warning.assert_called_once()
    assert "AUTOLAB_READONLY_DB_URL" in warning.call_args.args[0]


def test_readonly_role_bootstrap_never_grants_writes() -> None:
    # The bootstrap SQL can't run locally (needs live PG); this tripwire only
    # fires if someone adds a write grant to the read-only role.
    sql = READONLY_ROLE_SQL.read_text(encoding="utf-8").upper()

    assert "GRANT SELECT" in sql
    assert not any(
        f"GRANT {verb}" in sql
        for verb in ("INSERT", "UPDATE", "DELETE", "TRUNCATE", "CREATE")
    )

from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, inspect


def test_head_migration_contains_artifact_ingestion_columns(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'migration.db'}"
    repo_root = Path(__file__).resolve().parents[1]
    config = Config(str(repo_root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", database_url)
    config.attributes["sqlalchemy_url"] = database_url

    command.upgrade(config, "head")

    engine = create_engine(database_url)
    try:
        inspector = inspect(engine)
        artifact_columns = {
            column["name"]: column
            for column in inspector.get_columns("artifact")
        }
        registry_indexes = {
            index["name"]: index
            for index in inspector.get_indexes("entity_registry")
        }

        assert artifact_columns["schema_version"]["nullable"] is False
        assert registry_indexes["ix_entity_registry_source_key"]["unique"]

        instrument_columns = {
            column["name"]: column
            for column in inspector.get_columns("instrument")
        }
        assert instrument_columns["category"]["nullable"] is False

        fab_step_columns = {
            column["name"] for column in inspector.get_columns("fab_step")
        }
        assert "fab_run_id" not in fab_step_columns
        assert "body" in fab_step_columns
        assert "body" in {
            column["name"] for column in inspector.get_columns("fab_recipe")
        }
        tables = set(inspector.get_table_names())
        assert "fab_run" not in tables
        assert "mask_set" not in tables
        assert "substrate_batch" in tables
        assert "software" in tables
        assert "body" in {
            column["name"] for column in inspector.get_columns("analysis_run")
        }
    finally:
        engine.dispose()


def test_destructive_migrations_refuse_populated_databases(
    tmp_path, monkeypatch
):
    """Upgrading a database that holds die/fab_run/mask_set records must stop
    unless the operator explicitly opts in after archiving."""
    import sqlalchemy as sa
    from alembic import command
    from alembic.config import Config

    monkeypatch.delenv("AUTOLAB_ALLOW_DESTRUCTIVE_MIGRATION", raising=False)
    db_path = tmp_path / "populated.db"
    url = f"sqlite:///{db_path}"
    repo_root = Path(__file__).resolve().parents[1]
    config = Config(str(repo_root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url)
    config.attributes["sqlalchemy_url"] = url
    # Stop just before the die drop, seed a die, then try to continue.
    command.upgrade(config, "b7e4c5d2a911")
    engine = sa.create_engine(url)
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO entity_registry "
                "(id, entity_type, accession, version, created_at, updated_at)"
                " VALUES (:id, 'die', 'DIE-2026-0001', 0, :at, :at)"
            ),
            {"id": "0" * 32, "at": "2026-01-01 00:00:00"},
        )
    engine.dispose()

    with pytest.raises(Exception, match="refusing to drop"):
        command.upgrade(config, "head")

    monkeypatch.setenv("AUTOLAB_ALLOW_DESTRUCTIVE_MIGRATION", "1")
    command.upgrade(config, "head")


def test_project_container_revision_downgrades_and_reupgrades(tmp_path: Path) -> None:
    """Populated database: the member column and item table come and go
    while the underlying wafer row survives."""
    import sqlalchemy as sa

    url = f"sqlite:///{tmp_path / 'projects.db'}"
    repo_root = Path(__file__).resolve().parents[1]
    config = Config(str(repo_root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url)
    config.attributes["sqlalchemy_url"] = url
    command.upgrade(config, "head")

    engine = create_engine(url)
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "INSERT INTO entity_registry "
                "(id, entity_type, accession, version, created_at, updated_at)"
                " VALUES (:pid, 'project', 'PRJ-2026-0001', 0, :at, :at),"
                " (:wid, 'wafer', 'W-2026-0001', 0, :at, :at)"
            ),
            {"pid": "1" * 32, "wid": "2" * 32, "at": "2026-01-01 00:00:00"},
        )
        conn.execute(
            sa.text(
                "INSERT INTO project (id, name, description, extra, status)"
                " VALUES (:pid, 'P', '', '{}', 'active')"
            ),
            {"pid": "1" * 32},
        )
        conn.execute(
            sa.text(
                "INSERT INTO wafer (id, name, description, extra, material, project_id)"
                " VALUES (:wid, 'W', '', '{}', 'Al', :pid)"
            ),
            {"wid": "2" * 32, "pid": "1" * 32},
        )
        conn.execute(
            sa.text(
                "INSERT INTO project_item (id, project_id, kind, title, position, created_at)"
                " VALUES (:iid, :pid, 'milestone', 'M', 0, :at)"
            ),
            {"iid": "3" * 32, "pid": "1" * 32, "at": "2026-01-01 00:00:00"},
        )
    engine.dispose()

    command.downgrade(config, "a9d4e2c7f156")
    engine = create_engine(url)
    inspector = inspect(engine)
    assert "project_item" not in inspector.get_table_names()
    assert "project_id" not in {c["name"] for c in inspector.get_columns("wafer")}
    assert "status" not in {c["name"] for c in inspector.get_columns("project")}
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT name FROM wafer")).scalar() == "W"
    engine.dispose()

    command.upgrade(config, "head")
    engine = create_engine(url)
    with engine.connect() as conn:
        assert conn.execute(sa.text("SELECT project_id FROM wafer")).scalar() is None
        assert conn.execute(sa.text("SELECT status FROM project")).scalar() == "active"
    engine.dispose()


def test_setup_layout_revision_adds_and_drops_json_columns(tmp_path: Path) -> None:
    url = f"sqlite:///{tmp_path / 'layout.db'}"
    repo_root = Path(__file__).resolve().parents[1]
    config = Config(str(repo_root / "alembic.ini"))
    config.set_main_option("sqlalchemy.url", url)
    config.attributes["sqlalchemy_url"] = url
    command.upgrade(config, "head")

    engine = create_engine(url)
    setup_columns = {c["name"] for c in inspect(engine).get_columns("experiment_setup")}
    instrument_columns = {c["name"] for c in inspect(engine).get_columns("instrument")}
    assert {"layout", "layout_evaluation"} <= setup_columns
    assert "default_layout" in instrument_columns
    engine.dispose()

    command.downgrade(config, "c4e8a1b7d203")
    engine = create_engine(url)
    setup_columns = {c["name"] for c in inspect(engine).get_columns("experiment_setup")}
    instrument_columns = {c["name"] for c in inspect(engine).get_columns("instrument")}
    assert not ({"layout", "layout_evaluation"} & setup_columns)
    assert "default_layout" not in instrument_columns
    engine.dispose()
    command.upgrade(config, "head")

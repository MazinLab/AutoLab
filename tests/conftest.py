import os
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.engine import Engine
from sqlmodel import Session, SQLModel


@pytest.fixture()
def engine() -> Iterator[Engine]:
    from labcore.db import make_engine

    import labcore.models

    url = os.environ.get("AUTOLAB_TEST_DB_URL", "sqlite://")
    engine = make_engine(url)
    SQLModel.metadata.drop_all(engine)
    SQLModel.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture()
def session(engine: Engine) -> Iterator[Session]:
    with Session(engine) as s:
        yield s


@pytest.fixture()
def client(engine: Engine) -> Iterator[TestClient]:
    from app.main import create_app

    with TestClient(create_app(engine)) as c:
        yield c

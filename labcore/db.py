import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from sqlite3 import Connection as SQLiteConnection
from typing import cast

from sqlalchemy import event
from sqlalchemy.engine import Connection, Engine, make_url
from sqlalchemy.pool import StaticPool
from sqlmodel import create_engine


def _sqlite_is_in_memory(url: str) -> bool:
    database = make_url(url).database
    return database in (None, "", ":memory:") or "mode=memory" in (database or "")


def make_engine(url: str) -> Engine:
    if url.startswith("sqlite"):
        # StaticPool keeps in-memory DBs alive across connections, but sharing
        # ONE connection between overlapping sessions interleaves their
        # transactions (writes acknowledged then rolled back by another
        # session's failure). File-backed SQLite therefore uses normal
        # per-checkout pooling with a busy timeout for writer contention.
        if _sqlite_is_in_memory(url):
            engine = create_engine(
                url,
                connect_args={"check_same_thread": False},
                poolclass=StaticPool,
            )
        else:
            engine = create_engine(
                url,
                connect_args={"check_same_thread": False, "timeout": 30},
            )

        @event.listens_for(engine, "connect")
        def _enable_sqlite_fks(
            dbapi_conn: SQLiteConnection, _record: object
        ) -> None:
            dbapi_conn.execute("PRAGMA foreign_keys=ON")

        return engine
    return create_engine(url)


@contextmanager
def readonly_connection(engine: Engine) -> Iterator[Connection]:
    """Yield a connection whose current transaction cannot modify the DB."""
    with engine.connect() as connection:
        if connection.dialect.name == "sqlite":
            dbapi_connection = cast(
                SQLiteConnection, connection.connection.driver_connection
            )
            dbapi_connection.execute("PRAGMA query_only=ON").close()
            # query_only stops writes to THIS database, but PRAGMAs that
            # change connection state (journal_mode) and ATTACH (arbitrary
            # file creation/read) still succeed. The authorizer closes those:
            # only reading, SELECT, functions, and recursive CTEs stay allowed.
            allowed = {
                sqlite3.SQLITE_READ,
                sqlite3.SQLITE_SELECT,
                sqlite3.SQLITE_FUNCTION,
                sqlite3.SQLITE_RECURSIVE,
            }

            def _authorize(action: int, *_args: object) -> int:
                if action in allowed:
                    return sqlite3.SQLITE_OK
                return sqlite3.SQLITE_DENY

            dbapi_connection.set_authorizer(_authorize)
            try:
                yield connection
            finally:
                connection.rollback()
                dbapi_connection.set_authorizer(None)
                dbapi_connection.execute("PRAGMA query_only=OFF").close()
            return

        if connection.dialect.name == "postgresql":
            transaction = connection.begin()
            try:
                connection.exec_driver_sql("SET TRANSACTION READ ONLY")
                yield connection
            finally:
                if transaction.is_active:
                    transaction.rollback()
            return

        raise ValueError(
            f"read-only connections are unsupported for "
            f"{connection.dialect.name!r}"
        )

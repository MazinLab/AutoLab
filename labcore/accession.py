from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlmodel import Field, Session, SQLModel

PREFIXES: dict[str, str] = {
    "project": "PROJ",
    "person": "PER",
    "agent": "AGT",
    "instrument": "INST",
    "design": "DSN",
    "fab_recipe": "RCP",
    "fab_step": "STEP",
    "substrate_batch": "SUB",
    "wafer": "W",
    "device": "DEV",
    "experiment_setup": "ES",
    "measurement_run": "MR",
    "analysis_run": "AR",
    "software": "SW",
    "result_summary": "RS",
    "artifact": "ART",
    "note": "NOTE",
    "review_task": "RT",
}


class AccessionCounter(SQLModel, table=True):
    """Internal per-entity, per-year sequence for human accession labels.

    Accession codes are never parsed as identity or as catalog relationships;
    callers use the entity registry's opaque UUID for those purposes.
    """

    __tablename__ = "accession_counter"

    entity_type: str = Field(primary_key=True)
    year: int = Field(primary_key=True)
    counter: int = 0


def next_accession(session: Session, entity_type: str, year: int) -> str:
    prefix = PREFIXES[entity_type]
    counter_table = AccessionCounter.__table__
    dialect = session.get_bind().dialect.name
    insert_fn = pg_insert if dialect == "postgresql" else sqlite_insert
    stmt = (
        insert_fn(counter_table)
        .values(entity_type=entity_type, year=year, counter=1)
        .on_conflict_do_update(
            index_elements=["entity_type", "year"],
            set_={"counter": counter_table.c.counter + 1},
        )
        .returning(counter_table.c.counter)
    )
    n = session.execute(stmt).scalar_one()
    return f"{prefix}-{year}-{n:04d}"

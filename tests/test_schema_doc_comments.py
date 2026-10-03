from labcore.schema_doc import describe_tables


def test_describe_tables_comments_every_table() -> None:
    # Agents rely on describe_schema docs; a new table without one is a bug.
    tables = describe_tables()

    undocumented_tables = sorted(
        table_name
        for table_name, table in tables.items()
        if not str(table["doc"]).strip()
    )
    assert undocumented_tables == []

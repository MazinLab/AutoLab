import pytest
from sqlmodel import Session

from labcore.service import create_entity, update_entity


def test_artifact_role_is_validated_on_create_and_update(
    session: Session,
) -> None:
    with pytest.raises(ValueError, match="invalid artifact role"):
        create_entity(session, "artifact", {"role": "source"})

    artifact = create_entity(session, "artifact", {"name": "result"})
    with pytest.raises(ValueError, match="invalid artifact role"):
        update_entity(session, artifact["id"], {"role": "figure"})


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("uri", "elsewhere.h5"),
        ("checksum_sha256", "b" * 64),
        ("size_bytes", 456),
        ("media_type", "application/octet-stream"),
        ("data_format", "parquet"),
        ("schema_version", "2"),
        ("role", "derived"),
    ],
)
def test_ingested_raw_artifact_payload_is_immutable(
    session: Session, field: str, value: object
) -> None:
    artifact = create_entity(
        session,
        "artifact",
        {
            "name": "raw sweep",
            "role": "raw",
            "uri": "runs/sweep.h5",
            "checksum_sha256": "a" * 64,
            "size_bytes": 123,
            "media_type": "application/x-hdf5",
            "data_format": "hdf5",
            "schema_version": "1",
        },
    )

    with pytest.raises(ValueError, match="ingested raw artifact"):
        update_entity(session, artifact["id"], {field: value})


def test_ingested_raw_artifact_metadata_stays_patchable(
    session: Session,
) -> None:
    artifact = create_entity(
        session,
        "artifact",
        {
            "name": "raw sweep",
            "role": "raw",
            "checksum_sha256": "a" * 64,
        },
    )

    updated = update_entity(
        session,
        artifact["id"],
        {"name": "annotated sweep", "description": "checked", "tag": 3},
    )

    assert updated is not None
    assert updated["name"] == "annotated sweep"
    assert updated["description"] == "checked"
    assert updated["extra"]["tag"] == 3



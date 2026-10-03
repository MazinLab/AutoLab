from __future__ import annotations

import asyncio
import pathlib
import uuid

import h5py
import numpy as np
import pyarrow as pa
import pyarrow.parquet as pq
import pytest
from fastmcp import Client
from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.config import Settings
from app.mcp.artifact_tools import MAX_DOCUMENT_BYTES
from app.mcp.server import create_mcp
from labcore.service import create_entity


def _call(engine: Engine, root: pathlib.Path, tool: str, arguments: dict):
    async def run():
        async with Client(create_mcp(engine, Settings(storage_root=root))) as client:
            return (await client.call_tool(tool, arguments)).data

    return asyncio.run(run())


def _make_artifact(engine: Engine, data: dict) -> dict:
    with Session(engine) as session:
        artifact = create_entity(session, "artifact", data)
        session.commit()
        return artifact


def test_read_document_returns_text_media_type_and_size(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    (tmp_path / "notes.md").write_text("# Cooldown 3\nQi looks low.")
    artifact = _make_artifact(
        engine,
        {"name": "notes", "uri": "notes.md", "media_type": "text/markdown"},
    )

    result = _call(
        engine, tmp_path, "read_document", {"artifact_id": str(artifact["id"])}
    )

    assert "Qi looks low" in result["text"]
    assert result["media_type"] == "text/markdown"
    assert result["size_bytes"] == (tmp_path / "notes.md").stat().st_size


def test_read_document_accepts_data_format_fallback_when_media_type_empty(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    (tmp_path / "log.txt").write_text("cooldown log")
    artifact = _make_artifact(
        engine, {"name": "log", "uri": "log.txt", "data_format": "txt"}
    )

    result = _call(
        engine, tmp_path, "read_document", {"artifact_id": str(artifact["id"])}
    )

    assert result["text"] == "cooldown log"


def test_read_document_rejects_binary_media_type(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    (tmp_path / "blob.bin").write_bytes(b"\x00\x01\x02" * 50)
    artifact = _make_artifact(
        engine,
        {
            "name": "blob",
            "uri": "blob.bin",
            "media_type": "application/octet-stream",
        },
    )

    with pytest.raises(Exception):
        _call(
            engine, tmp_path, "read_document", {"artifact_id": str(artifact["id"])}
        )


def test_read_document_rejects_oversized_file_reporting_actual_size(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    oversize = MAX_DOCUMENT_BYTES + 1
    (tmp_path / "big.txt").write_text("x" * oversize)
    artifact = _make_artifact(
        engine, {"name": "big", "uri": "big.txt", "media_type": "text/plain"}
    )

    with pytest.raises(Exception) as excinfo:
        _call(
            engine, tmp_path, "read_document", {"artifact_id": str(artifact["id"])}
        )
    assert str(oversize) in str(excinfo.value)


def test_read_document_rejects_unknown_artifact(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    with pytest.raises(Exception):
        _call(
            engine,
            tmp_path,
            "read_document",
            {"artifact_id": str(uuid.uuid4())},
        )


def test_summarize_array_hdf5_reports_shape_dtype_and_stats(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    arr = np.arange(24, dtype="f8").reshape(4, 6)
    with h5py.File(tmp_path / "sweep.h5", "w") as handle:
        handle.create_dataset("data", data=arr)
        handle.create_dataset("aux", data=np.ones(3))
    artifact = _make_artifact(
        engine, {"name": "sweep", "uri": "sweep.h5", "data_format": "hdf5"}
    )

    result = _call(
        engine, tmp_path, "summarize_array", {"artifact_id": str(artifact["id"])}
    )

    assert result["kind"] == "hdf5"
    assert list(result["shape"]) == [4, 6]
    assert "float64" in result["dtype"]
    assert result["stats"]["mean"] == pytest.approx(arr.mean())
    assert result["stats"]["std"] == pytest.approx(arr.std())
    assert result["stats"]["min"] == pytest.approx(arr.min())
    assert result["stats"]["max"] == pytest.approx(arr.max())
    assert set(result["datasets"]) == {"data", "aux"}


def test_summarize_array_hdf5_stats_are_nan_aware(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    arr = np.arange(12, dtype="f8").reshape(3, 4)
    arr[0, 0] = np.nan
    with h5py.File(tmp_path / "nan.h5", "w") as handle:
        handle.create_dataset("data", data=arr)
    artifact = _make_artifact(
        engine, {"name": "nan", "uri": "nan.h5", "data_format": "hdf5"}
    )

    result = _call(
        engine, tmp_path, "summarize_array", {"artifact_id": str(artifact["id"])}
    )

    assert result["stats"]["mean"] == pytest.approx(np.nanmean(arr))
    assert result["stats"]["max"] == pytest.approx(np.nanmax(arr))


def test_summarize_array_hdf5_missing_dataset_raises(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    with h5py.File(tmp_path / "sweep.h5", "w") as handle:
        handle.create_dataset("data", data=np.ones(4))
    artifact = _make_artifact(
        engine, {"name": "sweep", "uri": "sweep.h5", "data_format": "hdf5"}
    )

    with pytest.raises(Exception):
        _call(
            engine,
            tmp_path,
            "summarize_array",
            {"artifact_id": str(artifact["id"]), "dataset": "missing"},
        )


def test_summarize_array_parquet_reports_rows_and_columns(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    pq.write_table(
        pa.table({"t": [1.0, 2.0, 3.0], "counts": [10, 20, 30]}),
        tmp_path / "events.parquet",
    )
    artifact = _make_artifact(
        engine,
        {"name": "events", "uri": "events.parquet", "data_format": "parquet"},
    )

    result = _call(
        engine, tmp_path, "summarize_array", {"artifact_id": str(artifact["id"])}
    )

    assert result["kind"] == "parquet"
    assert result["num_rows"] == 3
    assert set(result["columns"]) == {"t", "counts"}
    assert set(result["column_types"]) == {"t", "counts"}


def test_summarize_array_unknown_format_raises_naming_format(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    (tmp_path / "data.weird").write_bytes(b"\x00\x01")
    artifact = _make_artifact(
        engine,
        {"name": "weird", "uri": "data.weird", "data_format": "weird"},
    )

    with pytest.raises(Exception) as excinfo:
        _call(
            engine,
            tmp_path,
            "summarize_array",
            {"artifact_id": str(artifact["id"])},
        )
    assert "weird" in str(excinfo.value)


def test_summarize_array_preserves_complex_iq_data(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    """MKID IQ data is complex; a float cast that drops the imaginary part
    is a silent physics bug."""
    arr = np.array([3 + 4j, 5 + 12j], dtype="c16")
    with h5py.File(tmp_path / "iq.h5", "w") as handle:
        handle.create_dataset("data", data=arr)
    artifact = _make_artifact(
        engine, {"name": "iq", "uri": "iq.h5", "data_format": "hdf5"}
    )
    result = _call(
        engine, tmp_path, "summarize_array", {"artifact_id": str(artifact["id"])}
    )
    stats = result["stats"]
    assert stats["kind"] == "complex"
    assert stats["min_abs"] == 5.0 and stats["max_abs"] == 13.0
    assert abs(stats["mean_real"] - 4.0) < 1e-12
    assert abs(stats["mean_imag"] - 8.0) < 1e-12


def test_summarize_array_integer_extrema_are_exact(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    big = 2**60 + 3  # not representable exactly in float64
    with h5py.File(tmp_path / "ints.h5", "w") as handle:
        handle.create_dataset("data", data=np.array([0, big], dtype="i8"))
    artifact = _make_artifact(
        engine, {"name": "ints", "uri": "ints.h5", "data_format": "hdf5"}
    )
    result = _call(
        engine, tmp_path, "summarize_array", {"artifact_id": str(artifact["id"])}
    )
    assert result["stats"]["max"] == big  # exact int, no float rounding


def test_summarize_parquet_tolerates_duplicate_column_names(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    table = pa.Table.from_arrays(
        [pa.array([1.0, 2.0]), pa.array([3, 4])], names=["x", "x"]
    )
    pq.write_table(table, tmp_path / "dup.parquet")
    artifact = _make_artifact(
        engine, {"name": "dup", "uri": "dup.parquet", "data_format": "parquet"}
    )
    result = _call(
        engine, tmp_path, "summarize_array", {"artifact_id": str(artifact["id"])}
    )
    assert result["num_rows"] == 2
    assert result["columns"] == ["x", "x"]
    assert [f["name"] for f in result["fields"]] == ["x", "x"]


def test_summarize_array_rejects_external_hdf5_links(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    root = tmp_path / "store"
    root.mkdir()
    outside = tmp_path / "outside.h5"
    with h5py.File(outside, "w") as h5:
        h5["data"] = np.arange(4.0)
    with h5py.File(root / "wrapper.h5", "w") as h5:
        h5["data"] = h5py.ExternalLink(str(outside), "data")
    artifact = _make_artifact(
        engine, {"name": "wrapper", "uri": "wrapper.h5", "data_format": "hdf5"}
    )

    with pytest.raises(Exception, match="external"):
        _call(
            engine,
            root,
            "summarize_array",
            {"artifact_id": str(artifact["id"])},
        )


def test_summarize_array_rejects_virtual_datasets(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    root = tmp_path / "store"
    root.mkdir()
    outside = tmp_path / "source.h5"
    with h5py.File(outside, "w") as h5:
        h5["data"] = np.arange(4.0)
    layout = h5py.VirtualLayout(shape=(4,), dtype="f8")
    layout[:] = h5py.VirtualSource(str(outside), "data", shape=(4,))
    with h5py.File(root / "vds.h5", "w") as h5:
        h5.create_virtual_dataset("data", layout)
    artifact = _make_artifact(
        engine, {"name": "vds", "uri": "vds.h5", "data_format": "hdf5"}
    )

    with pytest.raises(Exception, match="virtual"):
        _call(
            engine,
            root,
            "summarize_array",
            {"artifact_id": str(artifact["id"])},
        )


def test_summarize_array_rejects_external_raw_storage(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    """external= raw storage keeps the dataset in-file but its BYTES outside;
    neither the backing-file check nor is_virtual sees it."""
    root = tmp_path / "store"
    root.mkdir()
    outside = tmp_path / "secret.bin"
    np.arange(4.0).tofile(outside)
    with h5py.File(root / "extern.h5", "w") as h5:
        h5.create_dataset(
            "data",
            shape=(4,),
            dtype="f8",
            external=[(str(outside), 0, 32)],
        )
    artifact = _make_artifact(
        engine, {"name": "extern", "uri": "extern.h5", "data_format": "hdf5"}
    )

    with pytest.raises(Exception, match="external"):
        _call(
            engine,
            root,
            "summarize_array",
            {"artifact_id": str(artifact["id"])},
        )


def test_summarize_array_streams_wide_sparse_rows(
    engine: Engine, tmp_path: pathlib.Path
) -> None:
    """A tiny sparse file declaring shape (1, N) with huge N must stream in
    bounded slabs, not materialize an N-element row."""
    root = tmp_path / "store"
    root.mkdir()
    with h5py.File(root / "wide.h5", "w") as h5:
        wide = h5.create_dataset("data", shape=(1, 8_000_000), dtype="f8")
        wide[0, :4] = [1.0, 2.0, 3.0, 4.0]
    artifact = _make_artifact(
        engine, {"name": "wide", "uri": "wide.h5", "data_format": "hdf5"}
    )

    import tracemalloc

    tracemalloc.start()
    summary = _call(
        engine, root, "summarize_array", {"artifact_id": str(artifact["id"])}
    )
    _, peak = tracemalloc.get_traced_memory()
    tracemalloc.stop()

    assert summary["shape"] == [1, 8_000_000]
    assert summary["stats"]["max"] == 4.0
    # 8M float64 = 64 MB if materialized whole; bounded slabs stay far under.
    assert peak < 48 * 1024 * 1024

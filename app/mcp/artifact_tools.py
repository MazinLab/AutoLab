from __future__ import annotations

import uuid
from pathlib import Path
from typing import TYPE_CHECKING, Iterator

from fastmcp import FastMCP
from sqlalchemy.engine import Engine
from sqlmodel import Session

from app.artifact_paths import resolve_artifact_path
from app.config import Settings
from labcore.service import get_entity

if TYPE_CHECKING:
    import numpy as np

# Text artifacts read_document will serve in full. text/* is always allowed;
# these cover the common structured-text media types that do not match text/*.
TEXT_MEDIA_TYPES: frozenset[str] = frozenset(
    {
        "application/json",
        "application/x-markdown",
        "text/markdown",
        "application/xml",
        "text/csv",
    }
)

# Fallback when an artifact records no media_type: trust these data_format tags.
TEXT_DATA_FORMATS: frozenset[str] = frozenset({"md", "txt", "json", "csv"})

# Hard ceiling on a single document read; multi-MB text is a bug, not a use case.
MAX_DOCUMENT_BYTES: int = 1_000_000

_HDF5_SUFFIXES: frozenset[str] = frozenset({".h5", ".hdf5"})
_PARQUET_SUFFIXES: frozenset[str] = frozenset({".parquet"})

# Element budget per HDF5 slab so multi-GB datasets never load whole.
_SLAB_ELEMENTS: int = 1 << 20


def _resolve_artifact_path(artifact: dict, storage_root: Path) -> Path:
    """Resolve an artifact URI under storage_root, rejecting escapes.

    Mirrors the containment rule of the REST download endpoint but raises
    ValueError (which fastmcp surfaces as a tool error) instead of HTTP errors.
    """
    uri = artifact.get("uri")
    if not isinstance(uri, str) or uri == "":
        raise ValueError("artifact has no URI")

    path = Path(uri)
    resolved = resolve_artifact_path(path, storage_root)
    if not resolved.is_file():
        raise ValueError("artifact file not found")
    return resolved


def _require_artifact(engine: Engine, artifact_id: str) -> dict:
    try:
        parsed_id = uuid.UUID(artifact_id)
    except (AttributeError, TypeError, ValueError) as exc:
        raise ValueError("artifact_id must be a UUID") from exc
    with Session(engine) as session:
        artifact = get_entity(session, parsed_id)
    if artifact is None or artifact.get("entity_type") != "artifact":
        raise ValueError(f"unknown artifact: {parsed_id}")
    return artifact


def _is_text_media(media_type: str, data_format: str) -> bool:
    if media_type:
        return media_type.startswith("text/") or media_type in TEXT_MEDIA_TYPES
    return data_format.lower() in TEXT_DATA_FORMATS


def _iter_slabs(dataset) -> Iterator["np.ndarray"]:
    """Yield slabs of an h5py dataset bounded by _SLAB_ELEMENTS per read.

    Never materializes the whole dataset; the design case is multi-GB files.
    Chunking only the leading axis is not enough — a tiny sparse file
    declaring shape (1, 100_000_000) would materialize the entire row — so
    wide rows are additionally chunked along the second axis.
    """
    import numpy as np

    if dataset.ndim == 0:
        yield np.asarray(dataset[()])
        return
    leading = dataset.shape[0]
    trailing = int(np.prod(dataset.shape[1:])) if dataset.ndim > 1 else 1
    if trailing <= _SLAB_ELEMENTS:
        slab_rows = max(1, _SLAB_ELEMENTS // max(trailing, 1))
        for start in range(0, leading, slab_rows):
            yield np.asarray(dataset[start : start + slab_rows])
        return

    inner = int(np.prod(dataset.shape[2:])) if dataset.ndim > 2 else 1
    if inner > _SLAB_ELEMENTS:
        raise ValueError(
            f"dataset inner dimensions {dataset.shape[2:]} exceed the "
            f"{_SLAB_ELEMENTS}-element streaming budget"
        )
    columns = max(1, _SLAB_ELEMENTS // inner)
    width = dataset.shape[1]
    for row in range(leading):
        for start in range(0, width, columns):
            yield np.asarray(dataset[row, start : start + columns])


def _accumulate(values: "np.ndarray", state: dict) -> None:
    """Fold one 1-D block into running count/mean/M2/min/max (Chan et al.)."""
    import numpy as np

    if values.size == 0:
        return
    slab_count = int(values.size)
    slab_mean = float(values.mean())
    slab_m2 = float(np.square(values - slab_mean).sum())
    combined = state["count"] + slab_count
    delta = slab_mean - state["mean"]
    state["m2"] += slab_m2 + delta * delta * state["count"] * slab_count / combined
    state["mean"] += delta * slab_count / combined
    state["count"] = combined
    state["min"] = min(state["min"], values.min())
    state["max"] = max(state["max"], values.max())


def _new_state() -> dict:
    return {"count": 0, "mean": 0.0, "m2": 0.0,
            "min": float("inf"), "max": float("-inf")}


def _streaming_stats(dataset) -> dict[str, object]:
    """Dtype-aware nan-aware stats by chunked iteration.

    Floats and integers report min/max/mean/std (integer extrema exact, kept
    as ints). Complex data — the MKID IQ case — must not lose its imaginary
    part to a float cast: it reports magnitude stats plus component means.
    """
    import numpy as np

    kind = np.dtype(dataset.dtype).kind
    if kind in ("S", "U", "O", "V", "M", "m"):
        raise ValueError(
            f"dataset dtype {dataset.dtype} is not numeric; "
            "stats are only defined for numeric datasets"
        )

    if kind == "c":
        abs_state = _new_state()
        real_sum = imag_sum = 0.0
        n = 0
        for slab in _iter_slabs(dataset):
            block = np.asarray(slab).ravel()
            finite = block[~np.isnan(block)]
            if finite.size == 0:
                continue
            _accumulate(np.abs(finite).astype("f8"), abs_state)
            real_sum += float(finite.real.sum())
            imag_sum += float(finite.imag.sum())
            n += int(finite.size)
        if n == 0:
            nan = float("nan")
            return {"kind": "complex", "min_abs": nan, "max_abs": nan,
                    "mean_abs": nan, "std_abs": nan,
                    "mean_real": nan, "mean_imag": nan}
        return {
            "kind": "complex",
            "min_abs": float(abs_state["min"]),
            "max_abs": float(abs_state["max"]),
            "mean_abs": abs_state["mean"],
            "std_abs": max(abs_state["m2"] / abs_state["count"], 0.0) ** 0.5,
            "mean_real": real_sum / n,
            "mean_imag": imag_sum / n,
        }

    integer = kind in ("i", "u", "b")
    state = _new_state()
    # Integer extrema tracked apart from the float64 accumulator: comparing
    # a float64 against a large int coerces and can keep the rounded float.
    exact_min: int | None = None
    exact_max: int | None = None
    for slab in _iter_slabs(dataset):
        block = np.asarray(slab).ravel()
        finite = block if integer else block[~np.isnan(block)]
        if finite.size == 0:
            continue
        _accumulate(finite.astype("f8"), state)
        if integer:
            slab_min, slab_max = int(finite.min()), int(finite.max())
            exact_min = slab_min if exact_min is None else min(exact_min, slab_min)
            exact_max = slab_max if exact_max is None else max(exact_max, slab_max)
    if state["count"] == 0:
        nan = float("nan")
        return {"min": nan, "max": nan, "mean": nan, "std": nan}
    return {
        "min": exact_min if integer else float(state["min"]),
        "max": exact_max if integer else float(state["max"]),
        "mean": state["mean"],
        "std": max(state["m2"] / state["count"], 0.0) ** 0.5,
    }


def _summarize_hdf5(path: Path, dataset: str) -> dict:
    import h5py

    with h5py.File(path, "r") as handle:
        datasets: dict[str, dict[str, object]] = {}

        def _collect(name: str, obj: object) -> None:
            if isinstance(obj, h5py.Dataset):
                datasets[name] = {
                    "shape": list(obj.shape),
                    "dtype": str(obj.dtype),
                }

        handle.visititems(_collect)

        target = handle.get(dataset)
        if not isinstance(target, h5py.Dataset):
            available = ", ".join(sorted(datasets)) or "none"
            raise ValueError(
                f"dataset {dataset!r} not found in HDF5 file (have: {available})"
            )
        # h5py silently follows external links (anywhere along the path) and
        # virtual-dataset mappings into OTHER files, which would read bytes
        # outside the validated artifact. Only datasets backed by the
        # validated file itself are summarized.
        backing_file = Path(target.file.filename).resolve()
        if backing_file != path:
            raise ValueError(
                f"dataset {dataset!r} resolves to an external file; "
                "external HDF5 links are not allowed"
            )
        if target.is_virtual:
            raise ValueError(
                f"dataset {dataset!r} is a virtual dataset; virtual "
                "datasets are not allowed"
            )
        # HDF5's third out-of-file mechanism: external= raw storage keeps the
        # dataset object in this file but its BYTES in another, which the
        # backing-file check above cannot see.
        if target.external:
            raise ValueError(
                f"dataset {dataset!r} uses external raw storage; "
                "externally backed datasets are not allowed"
            )
        return {
            "kind": "hdf5",
            "dataset": dataset,
            "datasets": datasets,
            "shape": list(target.shape),
            "dtype": str(target.dtype),
            "stats": _streaming_stats(target),
        }


def _summarize_parquet(path: Path) -> dict:
    import pyarrow.parquet as pq

    parquet_file = pq.ParquetFile(path)
    schema = parquet_file.schema_arrow
    # Enumerate fields by position: duplicate column names are legal Parquet
    # and schema.field(name) raises on them.
    fields = [
        {"name": schema.field(i).name, "type": str(schema.field(i).type)}
        for i in range(len(schema.names))
    ]
    return {
        "kind": "parquet",
        "num_rows": parquet_file.metadata.num_rows,
        "columns": list(schema.names),
        "fields": fields,
        "column_types": {f["name"]: f["type"] for f in fields},
    }


def register_artifact_tools(mcp: FastMCP, engine: Engine, settings: Settings) -> None:
    """Register read_document and summarize_array against the catalog."""

    @mcp.tool
    def read_document(artifact_id: str) -> dict:
        """Return the text of a small text artifact stored under storage_root."""
        artifact = _require_artifact(engine, artifact_id)
        media_type = str(artifact.get("media_type") or "")
        data_format = str(artifact.get("data_format") or "")
        if not _is_text_media(media_type, data_format):
            raise ValueError(
                f"artifact media type {media_type or data_format or 'unknown'!r} "
                "is not a readable text type"
            )

        path = _resolve_artifact_path(artifact, settings.storage_root)
        size_bytes = path.stat().st_size
        if size_bytes > MAX_DOCUMENT_BYTES:
            raise ValueError(
                f"artifact is {size_bytes} bytes, exceeds the "
                f"{MAX_DOCUMENT_BYTES}-byte read_document limit"
            )
        return {
            "text": path.read_text(encoding="utf-8"),
            "media_type": media_type,
            "size_bytes": size_bytes,
        }

    @mcp.tool
    def summarize_array(artifact_id: str, dataset: str = "data") -> dict:
        """Summarize an HDF5 or Parquet artifact without shipping the file."""
        artifact = _require_artifact(engine, artifact_id)
        path = _resolve_artifact_path(artifact, settings.storage_root)
        data_format = str(artifact.get("data_format") or "").lower()
        suffix = path.suffix.lower()

        if data_format == "hdf5" or suffix in _HDF5_SUFFIXES:
            return _summarize_hdf5(path, dataset)
        if data_format == "parquet" or suffix in _PARQUET_SUFFIXES:
            return _summarize_parquet(path)
        raise ValueError(
            f"unsupported array format: {data_format or suffix or 'unknown'}"
        )

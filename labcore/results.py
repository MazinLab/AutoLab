"""Result summaries: validation of analysis results and summary columns,
and the table that joins them.

Values live on the analysis (``analysis_run.results``); a summary only
chooses which keys to show. Membership is ``analysis_run REFERS_TO
result_summary``.
"""

from __future__ import annotations

import math
import re
import uuid

from sqlmodel import Session, select

from labcore.models.base import EntityRegistry
from labcore.models.edges import ProvenanceEdge, RelationType
from labcore.models.entities import AnalysisRun, Note, Project, ResultSummary

RESULT_KEY_RE = re.compile(r"^[A-Za-z0-9_./%+-]+$")


def validate_results(results: object) -> dict:
    """Return a clean flat map or raise ValueError describing the problem."""
    if not isinstance(results, dict):
        raise ValueError("results must be an object of key -> number or string")
    clean: dict = {}
    for key, value in results.items():
        # fullmatch: re.match with `$` would accept a trailing newline.
        if not isinstance(key, str) or not RESULT_KEY_RE.fullmatch(key):
            raise ValueError(
                f"result key {key!r} must match {RESULT_KEY_RE.pattern} (units go in the name)"
            )
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            raise ValueError(f"result {key!r} must be a number or a string")
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"result {key!r} must be finite")
        clean[key] = value
    return clean


def validate_columns(columns: object) -> list[dict]:
    """Return [{"key", "label"}] with labels defaulted to "" or raise ValueError."""
    if not isinstance(columns, list):
        raise ValueError("columns must be a list of {key, label} objects")
    clean: list[dict] = []
    seen: set[str] = set()
    for entry in columns:
        if not isinstance(entry, dict):
            raise ValueError("each column must be an object with a key")
        key = entry.get("key")
        if not isinstance(key, str) or not RESULT_KEY_RE.fullmatch(key):
            raise ValueError(f"column key {key!r} must match {RESULT_KEY_RE.pattern}")
        if key in seen:
            raise ValueError(f"column key {key!r} is listed twice")
        label = entry.get("label", "")
        if not isinstance(label, str):
            raise ValueError(f"column {key!r} label must be a string")
        seen.add(key)
        clean.append({"key": key, "label": label})
    return clean


def _brief(reg: EntityRegistry, name: str) -> dict:
    return {"id": str(reg.id), "accession": reg.accession, "name": name}


def _experiments_for(session: Session, analysis_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    """analysis id -> brief of the Experiment note it derives from (first edge wins)."""
    if not analysis_ids:
        return {}
    rows = session.exec(
        select(ProvenanceEdge.src_id, EntityRegistry, Note.name)
        .join(EntityRegistry, EntityRegistry.id == ProvenanceEdge.dst_id)  # type: ignore[arg-type]
        .join(Note, Note.id == EntityRegistry.id)  # type: ignore[arg-type]
        .where(
            ProvenanceEdge.src_id.in_(analysis_ids),  # type: ignore[attr-defined]
            ProvenanceEdge.relation == str(RelationType.DERIVED_FROM),
            Note.template == "Experiment",
        )
        .order_by(ProvenanceEdge.created_at, EntityRegistry.id)  # type: ignore[attr-defined]
    ).all()
    out: dict[uuid.UUID, dict] = {}
    for src_id, reg, name in rows:
        out.setdefault(src_id, _brief(reg, name))
    return out


def _projects_for(session: Session, project_ids: set[uuid.UUID]) -> dict[uuid.UUID, dict]:
    if not project_ids:
        return {}
    rows = session.exec(
        select(EntityRegistry, Project.name)
        .join(Project, Project.id == EntityRegistry.id)  # type: ignore[arg-type]
        .where(EntityRegistry.id.in_(project_ids))  # type: ignore[attr-defined]
    ).all()
    return {reg.id: _brief(reg, name) for reg, name in rows}


def summary_table(session: Session, summary_id: uuid.UUID) -> dict:
    """Rows (analyses) and columns (result keys) of one result summary.

    Rows follow analysis creation order; ``keys`` is the union of result
    keys in first-seen order (sorted within each analysis, since JSONB does
    not keep insertion order); ``columns`` is the stored list when set
    (labels defaulting to the key) or one entry per key.
    """
    reg = session.get(EntityRegistry, summary_id)
    if reg is None or reg.entity_type != "result_summary":
        raise LookupError(f"not a result summary: {summary_id}")
    summary = session.get(ResultSummary, summary_id)
    members = session.exec(
        select(EntityRegistry, AnalysisRun)
        .join(AnalysisRun, AnalysisRun.id == EntityRegistry.id)  # type: ignore[arg-type]
        .join(ProvenanceEdge, ProvenanceEdge.src_id == EntityRegistry.id)  # type: ignore[arg-type]
        .where(
            ProvenanceEdge.relation == str(RelationType.REFERS_TO),
            ProvenanceEdge.dst_id == summary_id,
        )
        .order_by(EntityRegistry.created_at, EntityRegistry.id)  # type: ignore[attr-defined]
    ).all()

    projects = _projects_for(
        session, {a.project_id for _, a in members if a.project_id is not None}
    )
    experiments = _experiments_for(session, [r.id for r, _ in members])
    keys: list[str] = []
    rows: list[dict] = []
    for analysis_reg, analysis in members:
        stored = analysis.results or {}
        results = {key: stored[key] for key in sorted(stored)}
        for key in results:
            if key not in keys:
                keys.append(key)
        rows.append(
            {
                "analysis": {
                    "id": str(analysis_reg.id),
                    "accession": analysis_reg.accession,
                    "name": analysis.name,
                    # A datetime, not a string: FastAPI serializes it like
                    # every other entity timestamp.
                    "created_at": analysis_reg.created_at,
                },
                "project": projects.get(analysis.project_id) if analysis.project_id else None,
                "experiment": experiments.get(analysis_reg.id),
                "results": results,
            }
        )

    stored_columns = list(summary.columns or []) if summary else []
    columns = (
        [{"key": c["key"], "label": c.get("label") or c["key"]} for c in stored_columns]
        if stored_columns
        else [{"key": key, "label": key} for key in keys]
    )
    return {
        "summary": {
            "id": str(reg.id),
            "accession": reg.accession,
            "name": summary.name if summary else "",
            "columns": stored_columns,
        },
        "keys": keys,
        "columns": columns,
        "rows": rows,
    }

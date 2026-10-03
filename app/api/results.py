"""Result summaries: the joined table of member analyses.

Registered before the generic entity router so
``/api/result_summary/{id}/table`` is not swallowed by
``/{entity_type}/{entity_id}``.
"""

import uuid

from fastapi import APIRouter, HTTPException

from app.api.entities import SessionDep
from labcore.results import summary_table

router = APIRouter(prefix="/api")


@router.get("/result_summary/{summary_id}/table")
def table(summary_id: uuid.UUID, session: SessionDep) -> dict:
    try:
        return summary_table(session, summary_id)
    except LookupError:
        raise HTTPException(404, "result summary not found")

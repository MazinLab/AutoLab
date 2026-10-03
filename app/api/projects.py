"""Project goals, milestones, and the progress report.

Registered before the generic entity router: ``/api/project/{id}/items``
would otherwise match ``/{entity_type}/{entity_id}``.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, Query, Response

from app.api.entities import ActorDep, SessionDep
from labcore.projects import (
    ProjectItemNotFoundError,
    ProjectNotFoundError,
    create_item,
    delete_item,
    list_items,
    project_report,
    reorder_items,
    set_item_done,
    update_item,
)

router = APIRouter(prefix="/api/project")


@router.get("/{project_id}/report")
def report(
    project_id: uuid.UUID,
    session: SessionDep,
    recent_limit: Annotated[int, Query(ge=0, le=50)] = 8,
    events_limit: Annotated[int, Query(ge=0, le=100)] = 20,
) -> dict:
    try:
        return project_report(
            session,
            project_id,
            recent_limit=recent_limit,
            events_limit=events_limit,
        )
    except ProjectNotFoundError:
        raise HTTPException(404, "project not found")


@router.get("/{project_id}/items")
def items(project_id: uuid.UUID, session: SessionDep) -> dict:
    try:
        return list_items(session, project_id)
    except ProjectNotFoundError:
        raise HTTPException(404, "project not found")


@router.post("/{project_id}/items", status_code=201)
def create(
    project_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
    body: Annotated[dict, Body()],
) -> dict:
    try:
        return create_item(
            session,
            project_id,
            str(body.get("kind", "")),
            body.get("title", ""),
            target_date=body.get("target_date"),
            actor_id=actor,
        )
    except ProjectNotFoundError:
        raise HTTPException(404, "project not found")
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.post("/{project_id}/items/reorder")
def reorder(
    project_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
    body: Annotated[dict, Body()],
) -> list[dict]:
    raw_ids = body.get("item_ids")
    if not isinstance(raw_ids, list):
        raise HTTPException(422, "item_ids must be a list")
    try:
        item_ids = [uuid.UUID(str(value)) for value in raw_ids]
    except ValueError:
        raise HTTPException(422, "item_ids must be UUIDs")
    try:
        return reorder_items(
            session, project_id, str(body.get("kind", "")), item_ids, actor_id=actor
        )
    except ProjectNotFoundError:
        raise HTTPException(404, "project not found")
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.patch("/{project_id}/items/{item_id}")
def patch(
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
    body: Annotated[dict, Body()],
) -> dict:
    try:
        return update_item(
            session, item_id, body, actor_id=actor, project_id=project_id
        )
    except ProjectItemNotFoundError:
        raise HTTPException(404, "item not found")
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.post("/{project_id}/items/{item_id}/done")
def done(
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
    body: Annotated[dict, Body()],
) -> dict:
    flag = body.get("done", True)
    if not isinstance(flag, bool):
        raise HTTPException(422, "done must be true or false")
    try:
        return set_item_done(
            session, item_id, flag, actor_id=actor, project_id=project_id
        )
    except ProjectItemNotFoundError:
        raise HTTPException(404, "item not found")
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.delete("/{project_id}/items/{item_id}", status_code=204)
def delete(
    project_id: uuid.UUID,
    item_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
) -> Response:
    try:
        delete_item(session, item_id, actor_id=actor, project_id=project_id)
    except ProjectItemNotFoundError:
        raise HTTPException(404, "item not found")
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    return Response(status_code=204)

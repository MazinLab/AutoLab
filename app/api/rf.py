"""Setup designer: parts library, evaluation, and a setup's layout.

Registered before the generic entity router so
``/api/experiment_setup/{id}/layout`` is not swallowed by
``/{entity_type}/{entity_id}``.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Body, Header, HTTPException, Response

from app.api.entities import (
    ActorDep,
    SessionDep,
    _etag,
    _parse_if_match,
)
from labcore.rfchain import (
    evaluate_layout,
    layout_device_ids,
    layout_instrument_ids,
    library_as_list,
    load_device_values,
    load_instrument_values,
    load_library,
    validate_layout,
    validate_layout_references,
)
from labcore.service import StaleVersionError, get_entity, update_entity

router = APIRouter(prefix="/api")


@router.get("/rf/parts")
def parts() -> dict:
    return library_as_list(load_library())


def _evaluate(session, layout: dict) -> dict:
    errors = validate_layout(layout)
    if not errors:
        errors = validate_layout_references(session, layout)
    if errors:
        raise HTTPException(422, "invalid layout: " + "; ".join(errors))
    return evaluate_layout(
        layout,
        instruments=load_instrument_values(session, layout_instrument_ids(layout)),
        devices=load_device_values(session, layout_device_ids(layout)),
    )


@router.post("/rf/evaluate")
def evaluate(session: SessionDep, body: Annotated[dict, Body()]) -> dict:
    layout = body.get("layout")
    if not isinstance(layout, dict):
        raise HTTPException(422, "layout must be an object")
    return _evaluate(session, layout)


def _layout_response(session, setup: dict) -> dict:
    layout = setup.get("layout") or {}
    return {
        "layout": layout,
        "evaluation": _evaluate(session, layout) if layout else None,
        "saved_evaluation": setup.get("layout_evaluation") or None,
    }


def _require_setup(session, setup_id: uuid.UUID) -> dict:
    setup = get_entity(session, setup_id)
    if setup is None or setup.get("entity_type") != "experiment_setup":
        raise HTTPException(404, "experiment setup not found")
    return setup


@router.get("/experiment_setup/{setup_id}/layout")
def get_layout(setup_id: uuid.UUID, session: SessionDep, response: Response) -> dict:
    setup = _require_setup(session, setup_id)
    response.headers["ETag"] = _etag(setup)
    return _layout_response(session, setup)


@router.put("/experiment_setup/{setup_id}/layout")
def put_layout(
    setup_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
    response: Response,
    body: Annotated[dict, Body()],
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> dict:
    layout = body.get("layout")
    if not isinstance(layout, dict):
        raise HTTPException(422, "layout must be an object")
    try:
        expected_version = _parse_if_match(if_match)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    _require_setup(session, setup_id)
    try:
        setup = update_entity(
            session,
            setup_id,
            {"layout": layout},
            actor_id=actor,
            expect_type="experiment_setup",
            expected_version=expected_version,
        )
    except StaleVersionError as exc:
        raise HTTPException(412, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    assert setup is not None
    response.headers["ETag"] = _etag(setup)
    return _layout_response(session, setup)

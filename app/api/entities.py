import uuid
from collections.abc import Iterator
from typing import Annotated

from fastapi import (
    APIRouter,
    Body,
    Depends,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
)
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from labcore.events import current_submitted_by
from labcore.service import (
    StaleVersionError,
    UnknownEntityTypeError,
    count_entities,
    create_entity,
    delete_entity,
    get_by_accession,
    get_entity,
    list_entities,
    update_entity,
)

router = APIRouter(prefix="/api")


def get_session(request: Request) -> Iterator[Session]:
    """The API layer owns the transaction: commit iff the handler succeeded.

    Service functions only flush, so a handler that raises mid-way leaves
    nothing behind — the session closes uncommitted and rolls back.
    """
    with Session(request.app.state.engine) as session:
        yield session
        session.commit()


SessionDep = Annotated[Session, Depends(get_session)]


def get_actor_id(
    x_actor_id: Annotated[uuid.UUID | None, Header()] = None,
) -> uuid.UUID | None:
    """The effective actor for this request.

    An explicit X-Actor-Id wins — acting as a colleague is a supported lab
    workflow, not an attack. Otherwise the person resolved by
    NetworkIdentityMiddleware from the tailscale serve headers is the
    default, so routine writes are attributed without picker interaction.
    record_event separately notes the resolved identity as submitted_by
    whenever it differs from the chosen actor.
    """
    if x_actor_id is not None:
        return x_actor_id
    return current_submitted_by()


ActorDep = Annotated[uuid.UUID | None, Depends(get_actor_id)]


def _etag(entity: dict) -> str:
    return f'"v{entity["version"]}"'


def _parse_if_match(if_match: str | None) -> int | None:
    if if_match is None:
        return None

    value = if_match.strip()
    if value == "*":
        return None
    if value[:2].lower() == "w/":
        value = value[2:].strip()

    starts_quoted = value.startswith('"')
    ends_quoted = value.endswith('"')
    if starts_quoted != ends_quoted:
        raise ValueError("If-Match must be a version ETag such as \"v3\"")
    if starts_quoted:
        value = value[1:-1]

    if not value.startswith("v") or not value[1:].isdigit():
        raise ValueError("If-Match must be a version ETag such as \"v3\"")
    return int(value[1:])


@router.get("/e/{accession}")
def resolve_accession(
    accession: str, session: SessionDep, response: Response
) -> dict:
    out = get_by_accession(session, accession)
    if out is None:
        raise HTTPException(404, f"no entity with accession {accession}")
    response.headers["ETag"] = _etag(out)
    return out


def _parse_links(data: dict) -> list[dict] | None:
    links = data.pop("links", None)
    if links is None:
        return None
    if not isinstance(links, list):
        raise HTTPException(422, "links must be an array of link objects")
    return links


@router.post("/{entity_type}", status_code=201)
def create(
    entity_type: str,
    session: SessionDep,
    actor: ActorDep,
    data: Annotated[dict, Body()],
) -> dict:
    source_key = data.pop("source_key", None)
    links = _parse_links(data)
    try:
        return create_entity(
            session,
            entity_type,
            data,
            actor_id=actor,
            source_key=source_key,
            links=links,
        )
    except UnknownEntityTypeError:
        raise HTTPException(404, f"unknown entity type {entity_type}")
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except IntegrityError as exc:
        raise HTTPException(
            409, f"conflicts with a database constraint: {exc.orig}"
        )


_LIST_RESERVED_PARAMS = {"limit", "offset", "order", "order_by", "q", "with_count"}


@router.get("/{entity_type}")
def list_(
    entity_type: str,
    request: Request,
    session: SessionDep,
    response: Response,
    limit: Annotated[int, Query(ge=0, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    order: Annotated[str, Query(pattern="^(asc|desc)$")] = "asc",
    order_by: Annotated[str, Query(pattern="^(created|updated)$")] = "created",
    q: str | None = None,
    with_count: bool = False,
) -> list[dict]:
    """List one entity type with server-side filtering.

    Beyond the reserved params: f.<field>=value filters a typed column by
    equality, x.<key>=value filters a JSON extra key by its text form. An
    unknown parameter or field is a 422, never silently ignored.
    """
    filters: dict[str, str] = {}
    extra_filters: dict[str, str] = {}
    for key, value in request.query_params.multi_items():
        if key in _LIST_RESERVED_PARAMS:
            continue
        if key.startswith("f."):
            filters[key[2:]] = value
        elif key.startswith("x."):
            extra_filters[key[2:]] = value
        else:
            raise HTTPException(422, f"unknown query parameter {key!r}")
    try:
        rows = list_entities(
            session,
            entity_type,
            limit=limit,
            offset=offset,
            newest_first=order == "desc",
            q=q,
            filters=filters,
            extra_filters=extra_filters,
            order_by=order_by,
        )
        if with_count:
            response.headers["X-Total-Count"] = str(
                count_entities(
                    session,
                    entity_type,
                    q=q,
                    filters=filters,
                    extra_filters=extra_filters,
                )
            )
        return rows
    except UnknownEntityTypeError:
        raise HTTPException(404, f"unknown entity type {entity_type}")
    except ValueError as exc:
        raise HTTPException(422, str(exc))


@router.get("/{entity_type}/{entity_id}")
def get_one(
    entity_type: str,
    entity_id: uuid.UUID,
    session: SessionDep,
    response: Response,
) -> dict:
    out = get_entity(session, entity_id)
    if out is None or out["entity_type"] != entity_type:
        raise HTTPException(404, "not found")
    response.headers["ETag"] = _etag(out)
    return out


@router.patch("/{entity_type}/{entity_id}")
def patch(
    entity_type: str,
    entity_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
    response: Response,
    data: Annotated[dict, Body()],
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> dict:
    try:
        expected_version = _parse_if_match(if_match)
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    try:
        out = update_entity(
            session,
            entity_id,
            data,
            actor_id=actor,
            expect_type=entity_type,
            expected_version=expected_version,
        )
    except StaleVersionError as exc:
        raise HTTPException(412, str(exc))
    except ValueError as exc:
        raise HTTPException(422, str(exc))
    except IntegrityError as exc:
        raise HTTPException(
            409, f"conflicts with a database constraint: {exc.orig}"
        )
    if out is None:
        raise HTTPException(404, "not found")
    response.headers["ETag"] = _etag(out)
    return out


@router.delete("/{entity_type}/{entity_id}", status_code=204)
def delete(
    entity_type: str,
    entity_id: uuid.UUID,
    session: SessionDep,
    actor: ActorDep,
) -> Response:
    """Hard delete. Rare by design: prefer supersedes for corrections.

    The record, its typed row, and all incident edges go; the event feed
    keeps a "deleted" tombstone with the identity snapshot.
    """
    try:
        out = delete_entity(
            session, entity_id, actor_id=actor, expect_type=entity_type
        )
    except ValueError as exc:
        raise HTTPException(409, str(exc))
    if out is None:
        raise HTTPException(404, "not found")
    return Response(status_code=204)

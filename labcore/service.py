from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime
from math import isfinite

from pydantic import TypeAdapter, ValidationError
from sqlalchemy import String, cast, func, update
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, SQLModel, or_, select

from labcore.accession import next_accession
from labcore.events import record_event
from labcore.models.base import EntityRegistry, utcnow
from labcore.models.edges import RelationType
from labcore.models.entities import (
    ENTITY_TYPES,
    ArtifactRole,
    Person,
    PersonNetworkIdentity,
    ProjectMemberMixin,
    ProjectStatus,
)

# Typed tables that carry an optional project_id (see ProjectMemberMixin).
PROJECT_MEMBER_TYPES: dict[str, type[SQLModel]] = {
    etype: cls
    for etype, cls in ENTITY_TYPES.items()
    if issubclass(cls, ProjectMemberMixin)
}


class UnknownEntityTypeError(KeyError):
    pass


class StaleVersionError(RuntimeError):
    pass


IDENTITY_FIELDS = {
    "id",
    "accession",
    "source_key",
    "version",
    "entity_type",
    "created_at",
    "updated_at",
    "created_by_id",
}

MAX_SOURCE_KEY_LENGTH = 255

IMMUTABLE_RAW_ARTIFACT_FIELDS = {
    "uri",
    "checksum_sha256",
    "size_bytes",
    "media_type",
    "data_format",
    "schema_version",
    "role",
}


def _table_for(entity_type: str) -> type[SQLModel]:
    try:
        return ENTITY_TYPES[entity_type]
    except KeyError as exc:
        raise UnknownEntityTypeError(entity_type) from exc


def _split_payload(
    cls: type[SQLModel], data: dict
) -> tuple[dict, dict]:
    """Split payload into typed columns and leftover keys destined for extra.

    An explicit ``extra`` object merges key-by-key (the shape /api/schema
    advertises) instead of nesting as ``extra["extra"]``; overflow top-level
    keys win on collision so the two spellings behave identically.
    """
    fields = set(cls.model_fields) - {"id", "extra"}
    typed = {k: v for k, v in data.items() if k in fields}
    extra = {k: v for k, v in data.items() if k not in fields and k != "extra"}
    explicit = data.get("extra")
    if explicit is not None:
        if not isinstance(explicit, dict):
            raise ValueError("extra must be an object")
        extra = {**explicit, **extra}
    return typed, extra


def _validate_typed_payload(
    cls: type[SQLModel],
    typed: dict,
    *,
    require_required_fields: bool,
) -> dict:
    if require_required_fields:
        missing = sorted(
            field_name
            for field_name, field in cls.model_fields.items()
            if field_name not in {"id", "extra"}
            and field.is_required()
            and field_name not in typed
        )
        if missing:
            raise ValueError(f"missing required fields: {missing}")

    validated = {}
    for field_name, value in typed.items():
        field = cls.model_fields[field_name]
        try:
            value = TypeAdapter(field.rebuild_annotation()).validate_python(
                value
            )
        except ValidationError as exc:
            raise ValueError(f"invalid {field_name}: {exc}") from exc
        if isinstance(value, datetime):
            if value.utcoffset() is None:
                raise ValueError(f"{field_name} must be timezone-aware")
            value = value.astimezone(UTC)
        if isinstance(value, float) and not isfinite(value):
            raise ValueError(f"{field_name} must be finite")
        validated[field_name] = value
    return validated


_CHECKSUM_SHA256_RE = re.compile(r"[0-9a-f]{64}")


def _validate_artifact_role(entity_type: str, typed: dict) -> None:
    if entity_type != "artifact":
        return
    role = typed.get("role")
    if role not in (None, ""):
        try:
            ArtifactRole(role)
        except ValueError as exc:
            raise ValueError(f"invalid artifact role: {role}") from exc
    checksum = typed.get("checksum_sha256")
    if checksum not in (None, "") and not _CHECKSUM_SHA256_RE.fullmatch(checksum):
        raise ValueError(
            "checksum_sha256 must be 64 lowercase hex characters"
        )
    size_bytes = typed.get("size_bytes")
    if size_bytes is not None and size_bytes < 0:
        raise ValueError("size_bytes must be non-negative")


def _validate_person_login(
    session: Session,
    entity_type: str,
    typed: dict,
    entity_id: uuid.UUID | None = None,
) -> None:
    """One network login maps to at most one person."""
    if entity_type != "person":
        return
    login = typed.get("tailscale_login")
    if not login:
        return
    identity = session.get(PersonNetworkIdentity, login)
    if identity is not None and identity.person_id != entity_id:
        raise ValueError(
            f"tailscale_login {login!r} is already linked to another person"
        )
    existing = session.exec(
        select(Person).where(Person.tailscale_login == login)
    ).first()
    if existing is not None and existing.id != entity_id:
        raise ValueError(
            f"tailscale_login {login!r} is already linked to another person"
        )


def _require_entity_of_type(
    session: Session, entity_id: uuid.UUID, entity_type: str, field: str
) -> None:
    reg = session.get(EntityRegistry, entity_id)
    if reg is None or reg.entity_type != entity_type:
        raise ValueError(f"{field} must reference a {entity_type}")


def _validate_project_fields(
    session: Session, entity_type: str, typed: dict
) -> None:
    """project_id must point at a project; a project's status and lead
    must be a known status and a person. Absent or null values pass."""
    project_id = typed.get("project_id")
    if project_id is not None:
        _require_entity_of_type(session, project_id, "project", "project_id")
    if entity_type != "project":
        return
    status = typed.get("status")
    if status is not None:
        try:
            ProjectStatus(status)
        except ValueError as exc:
            raise ValueError(f"invalid project status: {status}") from exc
    lead_id = typed.get("lead_id")
    if lead_id is not None:
        _require_entity_of_type(session, lead_id, "person", "lead_id")


def _record_membership_change(
    session: Session,
    reg: EntityRegistry,
    old_project: uuid.UUID | None,
    new_project: uuid.UUID | None,
    actor_id: uuid.UUID | None,
) -> None:
    """Project feeds show arrivals and departures; the member's own events
    follow the member, so a move would otherwise be invisible on the old
    project."""
    if old_project == new_project:
        return
    payload = {
        "entity_id": str(reg.id),
        "entity_type": reg.entity_type,
        "accession": reg.accession,
    }
    if old_project is not None:
        record_event(
            session,
            "project.member_removed",
            old_project,
            actor_id=actor_id,
            payload=payload,
        )
    if new_project is not None:
        record_event(
            session,
            "project.member_added",
            new_project,
            actor_id=actor_id,
            payload=payload,
        )


def _validate_layout_payload(
    session: Session, entity_type: str, typed: dict
) -> None:
    """Setup designer documents are validated on every write path (create,
    update, clone, MCP) so an invalid layout never reaches the row."""
    from labcore.rfchain import THROUGH_DEVICE, validate_layout, validate_layout_references

    if entity_type == "experiment_setup":
        layout = typed.get("layout")
    elif entity_type == "instrument":
        layout = typed.get("default_layout")
        # A testbed default describes wiring, never which chips were in;
        # strip device bindings so new setups start unassigned. A through
        # line is wiring, so that binding stays.
        if isinstance(layout, dict) and isinstance(layout.get("feedlines"), dict):
            layout["feedlines"] = {
                label: {
                    k: v
                    for k, v in binding.items()
                    if k != "device_id" or v == THROUGH_DEVICE
                }
                for label, binding in layout["feedlines"].items()
                if isinstance(binding, dict)
            }
    else:
        return
    if not layout:
        return
    errors = validate_layout(layout)
    if not errors:
        errors = validate_layout_references(session, layout)
    if errors:
        raise ValueError("invalid layout: " + "; ".join(errors))


def _validate_results_payload(entity_type: str, typed: dict) -> None:
    """Analysis results and summary columns are normalized on every write
    path so the table endpoint never meets a malformed map."""
    from labcore.results import validate_columns, validate_results

    if entity_type == "analysis_run" and "results" in typed:
        typed["results"] = validate_results(typed["results"])
    elif entity_type == "result_summary" and "columns" in typed:
        typed["columns"] = validate_columns(typed["columns"])


def _apply_setup_layout(
    session: Session,
    row: SQLModel,
    old_layout: dict,
    actor_id: uuid.UUID | None,
) -> None:
    """After a setup's layout is written: reconcile designer owned
    ``instrument MOUNTED_IN setup`` edges and store the evaluation snapshot.

    Only bindings that were in a layout are ever removed, so equipment
    links made through the Related records control survive."""
    from labcore.lineage import add_edge, remove_edge
    from labcore.rfchain import (
        evaluate_layout,
        evaluation_snapshot,
        layout_bound_ids,
        layout_device_ids,
        layout_instrument_ids,
        load_device_values,
        load_instrument_values,
    )

    new_layout = row.layout or {}
    old_ids = layout_bound_ids(old_layout or {})
    new_ids = layout_bound_ids(new_layout)
    for bound_id in sorted(new_ids - old_ids, key=str):
        add_edge(session, bound_id, RelationType.MOUNTED_IN, row.id, actor_id=actor_id)
    for bound_id in sorted(old_ids - new_ids, key=str):
        remove_edge(session, bound_id, RelationType.MOUNTED_IN, row.id, actor_id=actor_id)
    if new_layout:
        row.layout_evaluation = evaluation_snapshot(
            evaluate_layout(
                new_layout,
                instruments=load_instrument_values(session, layout_instrument_ids(new_layout)),
                devices=load_device_values(session, layout_device_ids(new_layout)),
            )
        )
    else:
        row.layout_evaluation = {}
    session.add(row)


def count_project_members(session: Session, project_id: uuid.UUID) -> int:
    total = 0
    for cls in PROJECT_MEMBER_TYPES.values():
        total += session.exec(
            select(func.count()).select_from(cls).where(cls.project_id == project_id)
        ).one()
    return total


def _link_person_login(
    session: Session, person_id: uuid.UUID, login: str | None
) -> None:
    """Retain every nonempty login ever linked through the Person field."""
    if not login:
        return
    identity = session.get(PersonNetworkIdentity, login)
    if identity is None:
        session.add(
            PersonNetworkIdentity(login=login, person_id=person_id)
        )
        return
    if identity.person_id != person_id:
        raise ValueError(
            f"tailscale_login {login!r} is already linked to another person"
        )


def _validate_source_key(source_key: object | None) -> str | None:
    if source_key is None:
        return None
    if not isinstance(source_key, str):
        raise ValueError("source_key must be a string")
    if not source_key:
        raise ValueError("source_key must not be empty")
    if len(source_key) > MAX_SOURCE_KEY_LENGTH:
        raise ValueError(
            f"source_key must be at most {MAX_SOURCE_KEY_LENGTH} characters"
        )
    return source_key


ACTOR_TYPES = {"person", "agent"}


def _to_dict(reg: EntityRegistry, row: SQLModel) -> dict:
    out = row.model_dump()
    out["entity_type"] = reg.entity_type
    out["accession"] = reg.accession
    out["source_key"] = reg.source_key
    out["version"] = reg.version
    out["created_at"] = reg.created_at
    out["updated_at"] = reg.updated_at
    out["created_by_id"] = reg.created_by_id
    return out


def require_actor(session: Session, actor_id: uuid.UUID | None) -> None:
    if actor_id is None:
        return
    reg = session.get(EntityRegistry, actor_id)
    if reg is None:
        raise ValueError(f"unknown actor: {actor_id}")
    if reg.entity_type not in ACTOR_TYPES:
        raise ValueError(
            f"actor must be a person or agent, got {reg.entity_type}"
        )


def _create_entity(
    session: Session,
    entity_type: str,
    data: dict,
    actor_id: uuid.UUID | None,
    source_key: str | None,
) -> dict:
    cls = _table_for(entity_type)
    typed, extra = _split_payload(cls, data)
    typed = _validate_typed_payload(
        cls, typed, require_required_fields=True
    )
    _validate_artifact_role(entity_type, typed)
    _validate_person_login(session, entity_type, typed)
    _validate_project_fields(session, entity_type, typed)
    _validate_layout_payload(session, entity_type, typed)
    _validate_results_payload(entity_type, typed)
    require_actor(session, actor_id)
    accession = next_accession(session, entity_type, utcnow().year)
    reg = EntityRegistry(
        entity_type=entity_type,
        accession=accession,
        source_key=source_key,
        created_by_id=actor_id,
    )
    row = cls(id=reg.id, extra=extra, **typed)
    session.add(reg)
    session.flush()
    session.add(row)
    if entity_type == "person":
        _link_person_login(session, row.id, row.tailscale_login)
    record_event(
        session,
        "created",
        reg.id,
        actor_id=actor_id,
        payload={"entity_type": entity_type},
    )
    _record_membership_change(
        session, reg, None, typed.get("project_id"), actor_id
    )
    if entity_type == "experiment_setup" and "layout" in typed:
        session.flush()
        _apply_setup_layout(session, row, {}, actor_id)
    session.flush()
    return _to_dict(reg, row)


_LINK_KEYS = {"relation", "dst_id", "dst_accession"}


def _apply_links(
    session: Session,
    src_id: uuid.UUID,
    links: list[dict],
    actor_id: uuid.UUID | None,
) -> None:
    """Create outbound edges in the caller's transaction (all-or-nothing)."""
    from labcore.lineage import add_edge

    for link in links:
        if not isinstance(link, dict):
            raise ValueError("each link must be an object")
        unknown = set(link) - _LINK_KEYS
        if unknown:
            raise ValueError(f"unknown link keys: {sorted(unknown)}")
        try:
            relation = RelationType(link.get("relation"))
        except ValueError:
            raise ValueError(f"unknown relation: {link.get('relation')!r}")
        dst = link.get("dst_id")
        if dst is not None:
            try:
                dst_id = uuid.UUID(str(dst))
            except ValueError:
                raise ValueError(f"invalid link dst_id: {dst!r}")
        else:
            accession = link.get("dst_accession")
            if not accession:
                raise ValueError("link needs dst_id or dst_accession")
            target = get_by_accession(session, accession)
            if target is None:
                raise ValueError(f"unknown accession: {accession!r}")
            dst_id = target["id"]
        add_edge(session, src_id, relation, dst_id, actor_id=actor_id)


def create_entity(
    session: Session,
    entity_type: str,
    data: dict,
    actor_id: uuid.UUID | None = None,
    *,
    source_key: str | None = None,
    links: list[dict] | None = None,
) -> dict:
    """Create an entity, optionally with its required provenance edges.

    links makes the record and its relationships one transaction: a link
    that fails to validate rolls back the entity too, so a Fab Step can
    never land without its wafer. On idempotent source_key replay the links
    are re-applied (add_edge is itself idempotent), converging a crashed
    partial write.
    """
    source_key = _validate_source_key(source_key)
    # Identity is server-assigned; a supplied id/accession/version would
    # otherwise land silently in extra and masquerade as identity.
    forbidden = IDENTITY_FIELDS & set(data)
    if forbidden:
        raise ValueError(
            f"cannot set identity fields on create: {sorted(forbidden)}"
        )
    if source_key is None:
        created = _create_entity(session, entity_type, data, actor_id, None)
        if links:
            _apply_links(session, created["id"], links, actor_id)
        return created

    try:
        with session.begin_nested():
            created = _create_entity(
                session, entity_type, data, actor_id, source_key
            )
    except IntegrityError:
        reg = session.exec(
            select(EntityRegistry).where(
                EntityRegistry.source_key == source_key
            )
        ).one_or_none()
        if reg is None:
            raise
        if reg.entity_type != entity_type:
            raise ValueError(
                f"source_key {source_key!r} belongs to {reg.entity_type}, "
                f"not {entity_type}"
            )
        existing = _fetch(session, reg)
        if existing is None:
            raise
        if links:
            _apply_links(session, existing["id"], links, actor_id)
        return existing
    if links:
        _apply_links(session, created["id"], links, actor_id)
    return created


def _fetch(session: Session, reg: EntityRegistry | None) -> dict | None:
    if reg is None:
        return None
    row = session.get(ENTITY_TYPES[reg.entity_type], reg.id)
    return None if row is None else _to_dict(reg, row)


def get_entity(session: Session, entity_id: uuid.UUID) -> dict | None:
    return _fetch(session, session.get(EntityRegistry, entity_id))


def get_by_accession(session: Session, accession: str) -> dict | None:
    reg = session.exec(
        select(EntityRegistry).where(EntityRegistry.accession == accession)
    ).one_or_none()
    return _fetch(session, reg)


def update_entity(
    session: Session,
    entity_id: uuid.UUID,
    patch: dict,
    actor_id: uuid.UUID | None = None,
    expect_type: str | None = None,
    expected_version: int | None = None,
) -> dict | None:
    forbidden = IDENTITY_FIELDS & set(patch)
    if forbidden:
        raise ValueError(f"cannot patch identity fields: {sorted(forbidden)}")
    require_actor(session, actor_id)
    reg = session.get(EntityRegistry, entity_id)
    if reg is None:
        return None
    if expect_type is not None and reg.entity_type != expect_type:
        return None  # validated BEFORE mutation: wrong-type PATCH is a no-op
    cls = ENTITY_TYPES[reg.entity_type]
    row = session.get(cls, entity_id)
    if row is None:
        return None
    if (
        reg.entity_type == "artifact"
        and row.role == ArtifactRole.RAW
        and row.checksum_sha256 != ""
    ):
        immutable = IMMUTABLE_RAW_ARTIFACT_FIELDS & set(patch)
        if immutable:
            raise ValueError(
                "cannot patch ingested raw artifact fields: "
                f"{sorted(immutable)}"
            )
    typed, extra = _split_payload(cls, patch)
    typed = _validate_typed_payload(
        cls, typed, require_required_fields=False
    )
    _validate_artifact_role(reg.entity_type, typed)
    _validate_person_login(session, reg.entity_type, typed, entity_id=entity_id)
    _validate_project_fields(session, reg.entity_type, typed)
    _validate_layout_payload(session, reg.entity_type, typed)
    _validate_results_payload(reg.entity_type, typed)
    old_project = getattr(row, "project_id", None)
    old_layout = dict(row.layout) if reg.entity_type == "experiment_setup" else {}

    now = utcnow()
    version_update = (
        update(EntityRegistry)
        .where(EntityRegistry.id == entity_id)
        .values(
            version=EntityRegistry.version + 1,
            updated_at=now,
        )
    )
    if expected_version is not None:
        version_update = version_update.where(
            EntityRegistry.version == expected_version
        )
    result = session.exec(version_update)
    if expected_version is not None and result.rowcount == 0:
        raise StaleVersionError(
            f"entity {entity_id} is no longer at version {expected_version}"
        )
    session.refresh(reg)

    for key, value in typed.items():
        setattr(row, key, value)
    if reg.entity_type == "person" and "tailscale_login" in typed:
        _link_person_login(session, row.id, typed["tailscale_login"])
    if extra:
        row.extra = {**row.extra, **extra}
    session.add(row)
    record_event(
        session,
        "updated",
        entity_id,
        actor_id=actor_id,
        payload={"patch": patch},  # record_event's _jsonable preserves structure
    )
    if "project_id" in typed:
        _record_membership_change(
            session, reg, old_project, typed["project_id"], actor_id
        )
    if reg.entity_type == "experiment_setup" and "layout" in typed:
        session.flush()
        _apply_setup_layout(session, row, old_layout, actor_id)
    session.flush()
    return _to_dict(reg, row)


def _require_deletable_actor(session: Session, entity_id: uuid.UUID) -> None:
    """An actor woven into history must stay resolvable; a fresh mistake may go."""
    from labcore.models.events import Event

    created = session.exec(
        select(EntityRegistry.id)
        .where(EntityRegistry.created_by_id == entity_id)
        .limit(1)
    ).first()
    if created is not None:
        raise ValueError(
            "cannot delete an actor that is recorded as creator of other records"
        )
    acted = session.exec(
        select(Event.id).where(Event.actor_id == entity_id).limit(1)
    ).first()
    if acted is not None:
        raise ValueError("cannot delete an actor with recorded activity")


def delete_entity(
    session: Session,
    entity_id: uuid.UUID,
    actor_id: uuid.UUID | None = None,
    expect_type: str | None = None,
) -> dict | None:
    """Hard-delete an entity, its typed row, and every incident edge.

    The "deleted" event is the durable tombstone: it snapshots identity
    (accession, type, name) and the removed edges, because after this
    transaction the registry row is gone. Artifact bytes on disk are NOT
    removed — the watcher will resurface them as an unregistered file.
    """
    from labcore.models.edges import ProvenanceEdge

    require_actor(session, actor_id)
    reg = session.get(EntityRegistry, entity_id)
    if reg is None:
        return None
    if expect_type is not None and reg.entity_type != expect_type:
        return None
    row = session.get(ENTITY_TYPES[reg.entity_type], entity_id)
    if row is None:
        return None
    if reg.entity_type in ACTOR_TYPES:
        if actor_id == entity_id:
            # The deletion event would reference the deleted actor and die
            # on the actor FK as a 500; refuse it as a client error instead.
            raise ValueError(
                "an actor cannot delete itself; act as someone else"
            )
        _require_deletable_actor(session, entity_id)
    if reg.entity_type == "project":
        from labcore.models.project_items import ProjectItem

        members = count_project_members(session, entity_id)
        if members:
            raise ValueError(
                f"project still contains {members} records; "
                "reassign or delete them first"
            )
        for item in session.exec(
            select(ProjectItem).where(ProjectItem.project_id == entity_id)
        ).all():
            session.delete(item)

    snapshot = _to_dict(reg, row)
    edges = session.exec(
        select(ProvenanceEdge).where(
            or_(
                ProvenanceEdge.src_id == entity_id,
                ProvenanceEdge.dst_id == entity_id,
            )
        )
    ).all()
    for edge in edges:
        session.delete(edge)
    record_event(
        session,
        "deleted",
        entity_id,
        actor_id=actor_id,
        payload={
            "entity_type": reg.entity_type,
            "accession": reg.accession,
            "name": snapshot.get("name", ""),
            "removed_edges": [
                {
                    "src_id": str(edge.src_id),
                    "relation": edge.relation,
                    "dst_id": str(edge.dst_id),
                }
                for edge in edges
            ],
        },
    )
    _record_membership_change(
        session, reg, getattr(row, "project_id", None), None, actor_id
    )
    # No ORM relationship links the typed row to its registry row, so the
    # unit of work can't order these deletes itself: flush the child first.
    session.delete(row)
    session.flush()
    session.delete(reg)
    session.flush()
    return snapshot


_EXTRA_KEY_RE = re.compile(r"[A-Za-z0-9_ .-]{1,64}")


def _escape_like(q: str) -> str:
    return q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _list_conditions(
    session: Session,
    cls: type[SQLModel],
    q: str | None,
    filters: dict[str, str] | None,
    extra_filters: dict[str, str] | None,
) -> list:
    conditions = []
    if q:
        pattern = f"%{_escape_like(q)}%"
        conditions.append(
            or_(
                getattr(cls, "name").ilike(pattern, escape="\\"),
                getattr(cls, "description").ilike(pattern, escape="\\"),
            )
        )
    for field_name, raw in (filters or {}).items():
        if field_name in {"id", "extra"} or field_name not in cls.model_fields:
            raise ValueError(f"unknown filter field: {field_name}")
        field = cls.model_fields[field_name]
        try:
            value = TypeAdapter(field.rebuild_annotation()).validate_python(raw)
        except ValidationError as exc:
            raise ValueError(f"invalid filter value for {field_name}: {exc}")
        conditions.append(getattr(cls, field_name) == value)
    for key, raw in (extra_filters or {}).items():
        if not _EXTRA_KEY_RE.fullmatch(key):
            raise ValueError(f"invalid extra filter key: {key!r}")
        extra_col = getattr(cls, "extra")
        if session.get_bind().dialect.name == "postgresql":
            text_value = extra_col.op("->>")(key)
        else:
            text_value = cast(
                func.json_extract(extra_col, f'$."{key}"'), String
            )
        # Text comparison on both dialects: numbers match their decimal form.
        conditions.append(text_value == raw)
    return conditions


def list_entities(
    session: Session,
    entity_type: str,
    limit: int = 50,
    offset: int = 0,
    newest_first: bool = False,
    *,
    q: str | None = None,
    filters: dict[str, str] | None = None,
    extra_filters: dict[str, str] | None = None,
    order_by: str = "created",
) -> list[dict]:
    cls = _table_for(entity_type)
    if order_by not in ("created", "updated"):
        raise ValueError("order_by must be 'created' or 'updated'")
    order_col = (
        EntityRegistry.created_at
        if order_by == "created"
        else EntityRegistry.updated_at
    )
    order = (
        (order_col.desc(), EntityRegistry.id.desc())  # type: ignore[attr-defined]
        if newest_first
        else (order_col, EntityRegistry.id)
    )
    rows = session.exec(
        select(EntityRegistry, cls)
        .join(cls, getattr(cls, "id") == EntityRegistry.id)
        .where(
            EntityRegistry.entity_type == entity_type,
            *_list_conditions(session, cls, q, filters, extra_filters),
        )
        .order_by(*order)
        .limit(limit)
        .offset(offset)
    ).all()
    return [_to_dict(reg, row) for reg, row in rows]


def count_entities(
    session: Session,
    entity_type: str,
    *,
    q: str | None = None,
    filters: dict[str, str] | None = None,
    extra_filters: dict[str, str] | None = None,
) -> int:
    cls = _table_for(entity_type)
    statement = (
        select(func.count())
        .select_from(EntityRegistry)
        .join(cls, getattr(cls, "id") == EntityRegistry.id)
        .where(
            EntityRegistry.entity_type == entity_type,
            *_list_conditions(session, cls, q, filters, extra_filters),
        )
    )
    return session.exec(statement).one()


def resolve_registry(
    session: Session, entity_id: uuid.UUID
) -> EntityRegistry | None:
    return session.get(EntityRegistry, entity_id)


def supersede_artifact(
    session: Session,
    old_id: uuid.UUID,
    data: dict,
    actor_id: uuid.UUID | None = None,
) -> dict:
    old = get_entity(session, old_id)
    if old is None or old["entity_type"] != "artifact":
        raise ValueError(f"entity is not an artifact: {old_id}")

    replacement = create_entity(
        session, "artifact", data, actor_id=actor_id
    )
    from labcore.lineage import add_edge

    add_edge(
        session,
        replacement["id"],
        RelationType.SUPERSEDES,
        old_id,
        actor_id=actor_id,
    )
    return replacement

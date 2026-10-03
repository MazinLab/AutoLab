from __future__ import annotations

import logging
import socket
import uuid
from datetime import datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from typing import Annotated

from fastapi import APIRouter, Body, HTTPException, Request
from sqlmodel import Session

from app.api.entities import ActorDep, SessionDep
from app.config import Settings
from app.identity import resolve_login
from labcore.events import record_event
from labcore.labeldesign import Label, computer_label, general_label, to_svg, to_zpl
from labcore.labelprint import render_zpl
from labcore.lineage_label import lineage_label
from labcore.service import get_entity, require_actor

router = APIRouter(prefix="/api")
logger = logging.getLogger(__name__)


def _local_date(created_at: datetime | None, timezone_name: str) -> str:
    """The creation date as mm/dd/yy in lab-local time.

    Stored timestamps are tz-aware UTC; a misconfigured timezone must not
    cost anyone a label, so it degrades to UTC rather than raising.
    """
    if created_at is None:
        return ""
    try:
        local = created_at.astimezone(ZoneInfo(timezone_name))
    except (ZoneInfoNotFoundError, ValueError):
        local = created_at
    return local.strftime("%m/%d/%y")


def _send_zpl(
    host: str,
    port: int,
    zpl: str,
    timeout: float = 5.0,
) -> None:
    connection = socket.create_connection((host, port), timeout=timeout)
    try:
        connection.sendall(zpl.encode("utf-8"))
    finally:
        connection.close()


def _printer_address(
    settings: Settings, printer_name: str | None
) -> tuple[str, str, int]:
    """Resolve a printer name (or the default) to ``(name, host, port)``."""
    if printer_name is None:
        printer_name = settings.default_printer or next(
            iter(settings.printers), ""
        )
    try:
        address = settings.printers[printer_name]
    except KeyError as exc:
        raise HTTPException(400, f"unknown printer {printer_name!r}") from exc

    try:
        host, port_text = address.rsplit(":", 1)
        port = int(port_text)
        if not host or not 1 <= port <= 65535:
            raise ValueError
    except (AttributeError, ValueError) as exc:
        raise HTTPException(
            500, f"invalid address for printer {printer_name!r}"
        ) from exc
    return printer_name, host, port


def print_label(
    session: Session,
    settings: Settings,
    entity_id: uuid.UUID,
    printer_name: str | None,
    label_format: str,
    *,
    actor_id: uuid.UUID | None = None,
) -> dict:
    try:
        require_actor(session, actor_id)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

    entity = get_entity(session, entity_id)
    if entity is None:
        raise HTTPException(404, "entity not found")

    printer_name, host, port = _printer_address(settings, printer_name)

    human_line = entity["name"] or lineage_label(session, entity_id)
    created_date = _local_date(entity["created_at"], settings.label_timezone)
    qr_url = f"{settings.public_base_url}/e/{entity['accession']}"
    try:
        zpl = render_zpl(
            entity["accession"],
            qr_url,
            human_line,
            label_format=label_format,
            created_date=created_date,
        )
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc

    try:
        _send_zpl(host, port, zpl)
    except OSError as exc:
        raise HTTPException(502, "printer connection failed") from exc

    record_event(
        session,
        "label_printed",
        entity_id,
        actor_id=actor_id,
        payload={"printer": printer_name, "format": label_format},
    )
    # The request session dependency commits after the handler succeeds.
    # Recording after send keeps failed connections out of the event history.
    return {"printer": printer_name, "format": label_format}


@router.get("/printers")
def printers(request: Request) -> list[str]:
    return list(request.app.state.settings.printers)


@router.post("/entities/{entity_id}/print-label")
def print_entity_label(
    entity_id: uuid.UUID,
    request: Request,
    session: SessionDep,
    actor: ActorDep,
    data: Annotated[dict, Body()],
) -> dict:
    printer_name = data.get("printer")
    label_format = data.get("label_format", "qr")
    if printer_name is not None and not isinstance(printer_name, str):
        raise HTTPException(422, "printer must be a string")
    if not isinstance(label_format, str):
        raise HTTPException(422, "label_format must be a string")
    return print_label(
        session,
        request.app.state.settings,
        entity_id,
        printer_name,
        label_format,
        actor_id=actor,
    )


# ---------------------------------------------------------------------------
# Label station: ad hoc labels that are not tied to a catalog entity.

STATION_TEMPLATES: dict[str, tuple[str, ...]] = {
    "computer": ("hostname", "mac", "ip"),
    "general": ("title", "body", "url"),
}
MAX_COPIES = 20


def _today(settings: Settings) -> str:
    return _local_date(datetime.now(tz=ZoneInfo("UTC")), settings.label_timezone)


def build_label(
    template: str,
    fields: dict,
    settings: Settings,
    logo: bool = False,
    logo_position: str = "left",
) -> tuple[Label, list[str]]:
    try:
        names = STATION_TEMPLATES[template]
    except KeyError as exc:
        raise ValueError(f"unknown template {template!r}") from exc
    values: list[str] = []
    for name in names:
        value = fields.get(name, "")
        if not isinstance(value, str):
            raise ValueError(f"field {name!r} must be a string")
        values.append(value)
    date = _today(settings)
    if template == "computer":
        return computer_label(*values, date, logo=logo, logo_position=logo_position)
    return general_label(*values, date, logo=logo, logo_position=logo_position)


def _station_request(data: dict) -> tuple[str, dict, bool, str]:
    template = data.get("template")
    fields = data.get("fields")
    logo = data.get("logo", False)
    logo_position = data.get("logo_position", "left")
    if not isinstance(template, str) or not isinstance(fields, dict):
        raise HTTPException(422, "template must be a string and fields an object")
    if not isinstance(logo, bool):
        raise HTTPException(422, "logo must be a boolean")
    if not isinstance(logo_position, str):
        raise HTTPException(422, "logo_position must be a string")
    return template, fields, logo, logo_position


@router.post("/labels/render")
def render_station_label(
    request: Request, data: Annotated[dict, Body()]
) -> dict:
    template, fields, logo, logo_position = _station_request(data)
    try:
        label, problems = build_label(
            template, fields, request.app.state.settings, logo, logo_position
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return {"svg": to_svg(label), "zpl": to_zpl(label), "problems": problems}


@router.post("/labels/print")
def print_station_label(
    request: Request, data: Annotated[dict, Body()]
) -> dict:
    template, fields, logo, logo_position = _station_request(data)
    copies = data.get("copies", 1)
    if isinstance(copies, bool) or not isinstance(copies, int) or not 1 <= copies <= MAX_COPIES:
        raise HTTPException(422, f"copies must be an integer from 1 to {MAX_COPIES}")
    printer_name = data.get("printer")
    if printer_name is not None and not isinstance(printer_name, str):
        raise HTTPException(422, "printer must be a string")

    settings = request.app.state.settings
    try:
        label, _ = build_label(template, fields, settings, logo, logo_position)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    printer_name, host, port = _printer_address(settings, printer_name)
    try:
        _send_zpl(host, port, to_zpl(label, copies))
    except OSError as exc:
        raise HTTPException(502, "printer connection failed") from exc
    # No catalog entity to hang an event on, so the server log is the record.
    logger.info(
        "station label printed",
        extra={
            "template": template,
            "logo": logo_position if logo else None,
            "printer": printer_name,
            "copies": copies,
            "login": resolve_login(request),
        },
    )
    return {"printer": printer_name, "copies": copies}

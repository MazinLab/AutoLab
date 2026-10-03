from __future__ import annotations

import hashlib
import os
import re
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Body, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlmodel import select

from app.api.entities import ActorDep, SessionDep
from app.artifact_paths import (
    create_upload_target,
    open_artifact_readonly,
    resolve_artifact_path,
)
from app.config import Settings
from labcore.lineage import add_edge
from labcore.models.edges import RelationType
from labcore.models.entities import Artifact
from labcore.service import create_entity, get_entity, supersede_artifact

router = APIRouter(prefix="/api")

# Attachments may annotate a record or refer to it; structural relations
# (derived_from, part_of, supersedes) would put uploads into ancestry.
_UPLOAD_RELATIONS = {RelationType.ANNOTATES, RelationType.REFERS_TO}

_UNSAFE_FILENAME_CHARS = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_filename(raw: str | None) -> str:
    name = Path(raw or "upload.bin").name
    cleaned = _UNSAFE_FILENAME_CHARS.sub("_", name).strip("._")
    return cleaned or "upload.bin"


def _canonicalize_artifact_uri(uri: object, storage_root: Path) -> str:
    if not isinstance(uri, str):
        raise ValueError("artifact URI must be a string")
    if uri == "":
        return uri

    root = storage_root.resolve()
    artifact_path = (root / Path(uri)).resolve()
    # relative_to without walk_up raises for any path outside storage_root,
    # so escapes are rejected at registration, not just at download.
    return artifact_path.relative_to(root).as_posix()


def _canonicalize_payload_uri(data: dict, storage_root: Path) -> None:
    if "uri" in data:
        data["uri"] = _canonicalize_artifact_uri(data["uri"], storage_root)


def _discard_upload(target: Path, upload_dir: Path) -> None:
    target.unlink(missing_ok=True)
    if upload_dir.is_dir():
        upload_dir.rmdir()


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_registered_bytes(data: dict, settings: Settings) -> None:
    """Catalog identity must describe the stored bytes, not the caller's claim.

    Registration by URI stats and hashes the file: a missing file, a wrong
    declared size, or a wrong declared checksum is a 422. Undeclared
    checksum/size are filled from the bytes.
    """
    uri = data.get("uri", "")
    if not isinstance(uri, str) or uri == "" or not settings.verify_artifact_bytes:
        return
    path = resolve_artifact_path(uri, settings.storage_root)
    if not path.is_file():
        raise HTTPException(422, f"no file at artifact URI {uri!r}")
    size = path.stat().st_size
    declared_size = data.get("size_bytes")
    if declared_size is not None and declared_size != size:
        raise HTTPException(
            422,
            f"declared size_bytes {declared_size} does not match stored "
            f"size {size}",
        )
    actual = _file_sha256(path)
    declared = data.get("checksum_sha256")
    if declared not in (None, "") and declared != actual:
        raise HTTPException(
            422, "declared checksum_sha256 does not match stored bytes"
        )
    data["checksum_sha256"] = actual
    data["size_bytes"] = size


@router.post("/artifact", status_code=201)
def create_artifact(
    request: Request,
    session: SessionDep,
    actor: ActorDep,
    data: Annotated[dict, Body()],
) -> dict:
    source_key = data.pop("source_key", None)
    links = data.pop("links", None)
    if links is not None and not isinstance(links, list):
        raise HTTPException(422, "links must be an array of link objects")
    settings: Settings = request.app.state.settings
    try:
        _canonicalize_payload_uri(data, settings.storage_root)
    except (TypeError, ValueError, OSError) as exc:
        raise HTTPException(400, "invalid artifact URI") from exc
    _verify_registered_bytes(data, settings)

    try:
        return create_entity(
            session,
            "artifact",
            data,
            actor_id=actor,
            source_key=source_key,
            links=links,
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.post("/artifacts/upload", status_code=201)
def upload_artifact(
    request: Request,
    session: SessionDep,
    actor: ActorDep,
    file: UploadFile,
    name: Annotated[str | None, Form()] = None,
    link_entity_id: Annotated[uuid.UUID | None, Form()] = None,
    relation: Annotated[str, Form()] = "annotates",
) -> dict:
    try:
        relation_type = RelationType(relation)
    except ValueError as exc:
        raise HTTPException(422, f"unknown relation {relation!r}") from exc
    if relation_type not in _UPLOAD_RELATIONS:
        raise HTTPException(
            422, "uploads may only annotate or refer_to a record"
        )
    if link_entity_id is not None and get_entity(session, link_entity_id) is None:
        raise HTTPException(404, "link target not found")

    settings: Settings = request.app.state.settings
    storage_root: Path = settings.storage_root
    max_bytes: int = settings.max_upload_bytes
    declared_length = request.headers.get("content-length")
    if declared_length is not None and declared_length.isdigit():
        # Multipart framing adds overhead, so this can only over-estimate the
        # file size — safe as an early reject, never a false accept.
        if int(declared_length) > max_bytes + 1_048_576:
            raise HTTPException(413, f"upload exceeds {max_bytes} bytes")

    filename = _safe_filename(file.filename)
    relative_dir = Path("uploads") / uuid.uuid4().hex
    upload_dir = storage_root / relative_dir
    # Descriptor walk with O_NOFOLLOW: a symlinked path component must fail,
    # not redirect the write outside the store.
    try:
        write_fd = create_upload_target(storage_root, relative_dir, filename)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc
    target = upload_dir / filename

    digest = hashlib.sha256()
    size = 0
    deduplicated = False
    try:
        with os.fdopen(write_fd, "wb") as out:
            while chunk := file.file.read(1024 * 1024):
                size += len(chunk)
                if size > max_bytes:
                    raise HTTPException(
                        413, f"upload exceeds {max_bytes} bytes"
                    )
                digest.update(chunk)
                out.write(chunk)

        checksum = digest.hexdigest()
        duplicate = session.exec(
            select(Artifact).where(
                Artifact.checksum_sha256 == checksum,
                Artifact.size_bytes == size,
            )
        ).first()
        # Dedup only when the existing object's bytes are actually present
        # and the right size — otherwise a stale catalog row (missing or
        # corrupted file) would swallow the only healthy copy.
        duplicate_path = (
            (storage_root / duplicate.uri) if duplicate and duplicate.uri else None
        )
        if (
            duplicate is not None
            and duplicate_path is not None
            and duplicate_path.is_file()
            and duplicate_path.stat().st_size == size
        ):
            target.unlink()
            upload_dir.rmdir()
            deduplicated = True
            artifact = get_entity(session, duplicate.id)
            assert artifact is not None
        else:
            suffix = Path(filename).suffix.lstrip(".").lower()
            artifact = create_entity(
                session,
                "artifact",
                {
                    "name": (name or "").strip() or filename,
                    "uri": target.relative_to(storage_root).as_posix(),
                    "checksum_sha256": checksum,
                    "size_bytes": size,
                    "media_type": file.content_type
                    or "application/octet-stream",
                    "data_format": suffix,
                    # Uploads are originals: raw + checksum arms the
                    # immutability guard on uri/checksum/size patches.
                    "role": "raw",
                },
                actor_id=actor,
            )
        if link_entity_id is not None:
            add_edge(
                session,
                artifact["id"],
                relation_type,
                link_entity_id,
                actor_id=actor,
            )
    except HTTPException:
        _discard_upload(target, upload_dir)
        raise
    except ValueError as exc:
        _discard_upload(target, upload_dir)
        raise HTTPException(422, str(exc)) from exc
    except Exception:
        _discard_upload(target, upload_dir)
        raise
    return {**artifact, "deduplicated": deduplicated}


_MEDIA_TYPE_RE = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+/[!#$%&'*+.^_`|~0-9A-Za-z-]+")


@router.get("/artifacts/{entity_id}/download")
def download_artifact(
    entity_id: uuid.UUID, request: Request, session: SessionDep
) -> StreamingResponse:
    artifact = get_entity(session, entity_id)
    if artifact is None or artifact["entity_type"] != "artifact":
        raise HTTPException(404, "artifact not found")

    # Open-then-stream from the descriptor: no pathname is reopened after
    # the containment check, so a concurrent symlink swap cannot redirect
    # the download outside the store.
    try:
        fd, file_stat = open_artifact_readonly(
            artifact["uri"], request.app.state.settings.storage_root
        )
    except FileNotFoundError:
        raise HTTPException(404, "artifact file not found")
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from exc
    except (TypeError, OSError) as exc:
        raise HTTPException(400, "invalid artifact URI") from exc

    stream = os.fdopen(fd, "rb")

    def iterfile() -> Iterator[bytes]:
        try:
            while chunk := stream.read(1024 * 1024):
                yield chunk
        finally:
            stream.close()

    media_type = artifact.get("media_type") or ""
    if not _MEDIA_TYPE_RE.fullmatch(media_type):
        media_type = "application/octet-stream"
    filename = _safe_filename(Path(artifact["uri"]).name)
    # Force download semantics: a cataloged HTML/SVG file rendered inline
    # would execute under the AutoLab origin with access to actor storage.
    return StreamingResponse(
        iterfile(),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Content-Length": str(file_stat.st_size),
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
        },
    )


@router.post("/artifacts/{entity_id}/supersede", status_code=201)
def supersede(
    entity_id: uuid.UUID,
    request: Request,
    session: SessionDep,
    actor: ActorDep,
    data: Annotated[dict, Body()],
) -> dict:
    if get_entity(session, entity_id) is None:
        raise HTTPException(404, "artifact not found")
    settings: Settings = request.app.state.settings
    try:
        _canonicalize_payload_uri(data, settings.storage_root)
    except (TypeError, ValueError, OSError) as exc:
        raise HTTPException(400, "invalid artifact URI") from exc
    _verify_registered_bytes(data, settings)

    try:
        return supersede_artifact(session, entity_id, data, actor_id=actor)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc

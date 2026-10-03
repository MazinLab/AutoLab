from __future__ import annotations

import os
import stat as stat_module
from pathlib import Path


def resolve_artifact_path(uri: str | Path, storage_root: Path) -> Path:
    """Resolve an artifact URI while enforcing storage-root containment."""
    path = Path(uri)
    if path.is_absolute():
        raise ValueError("artifact URI must be relative")

    root = storage_root.resolve()
    resolved = (root / path).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("artifact URI escapes storage root")
    return resolved


def open_artifact_readonly(
    uri: str | Path, storage_root: Path
) -> tuple[int, os.stat_result]:
    """Open an artifact for reading without a check/open race.

    resolve-then-open is exploitable: a directory swapped for a symlink
    between the containment check and the open serves an outside file. This
    walks each component beneath the (trusted, pre-resolved) storage root
    with O_NOFOLLOW, so no symlink inside the store is ever followed, and
    returns the already-open descriptor the caller streams from.

    Raises ValueError for escapes/symlinks/non-files and FileNotFoundError
    when the file does not exist.
    """
    rel = Path(uri)
    if rel.is_absolute():
        raise ValueError("artifact URI must be relative")
    parts = rel.parts
    if not parts or any(part in ("..", ".") for part in parts):
        raise ValueError("artifact URI escapes storage root")

    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open(storage_root.resolve(), os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, dir_flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    except OSError as exc:
        if exc.errno == getattr(os, "ELOOP", None) or (
            # macOS surfaces O_NOFOLLOW hits as EMLINK on some paths
            exc.errno == getattr(os, "EMLINK", None)
        ):
            raise ValueError("artifact path contains a symlink") from exc
        if isinstance(exc, NotADirectoryError):
            raise ValueError("artifact URI is not a regular file") from exc
        raise
    finally:
        os.close(fd)

    file_stat = os.fstat(file_fd)
    if not stat_module.S_ISREG(file_stat.st_mode):
        os.close(file_fd)
        raise ValueError("artifact URI is not a regular file")
    return file_fd, file_stat


def create_upload_target(
    storage_root: Path, relative_dir: Path, filename: str
) -> int:
    """Create relative_dir under storage_root and open filename for writing.

    The reader walk above protects downloads; this is its write-side twin.
    Every directory component is created and opened with O_NOFOLLOW relative
    to the previous descriptor, and the file itself with O_CREAT|O_EXCL, so
    a symlinked component (e.g. an "uploads" dir swapped for a link out of
    the store) is an error, never a traversal.
    """
    if relative_dir.is_absolute() or any(
        part in ("..", ".") for part in relative_dir.parts
    ):
        raise ValueError("upload directory escapes storage root")
    if "/" in filename or filename in ("", ".", ".."):
        raise ValueError("invalid upload filename")

    dir_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root = storage_root.resolve()
    os.makedirs(root, exist_ok=True)  # the root itself is trusted config
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in relative_dir.parts:
            try:
                os.mkdir(part, dir_fd=fd)
            except FileExistsError:
                pass
            next_fd = os.open(part, dir_flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return os.open(
            filename,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o644,
            dir_fd=fd,
        )
    except OSError as exc:
        if exc.errno in (
            getattr(os, "ELOOP", None),
            getattr(os, "EMLINK", None),
        ):
            raise ValueError("upload path contains a symlink") from exc
        if isinstance(exc, NotADirectoryError):
            raise ValueError("upload path component is not a directory") from exc
        raise
    finally:
        os.close(fd)

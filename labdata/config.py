"""Environment-based configuration for instrument PCs.

One env-var convention instead of per-script constructor plumbing:

    AUTOLAB_URL          catalog base URL (e.g. http://mec.tail...:80)
    AUTOLAB_ACTOR_ID     agent/person UUID this machine writes as
    AUTOLAB_STORAGE_DIR  the artifact store as mounted on THIS machine
    AUTOLAB_SPOOL_DIR    durable outbox dir (default: ~/.autolab-spool)
    AUTOLAB_TIMEOUT_S    HTTP timeout (default 5)

``session_from_env`` is the one-call setup an acquisition script needs.
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path

from labdata.client import LabData
from labdata.session import MeasurementSession
from labdata.spool import Spool

_Id = uuid.UUID | str


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is not set")
    return value


def client_from_env() -> LabData:
    return LabData.for_url(
        _require("AUTOLAB_URL"),
        actor_id=os.environ.get("AUTOLAB_ACTOR_ID") or None,
        timeout=float(os.environ.get("AUTOLAB_TIMEOUT_S", "5")),
    )


def storage_dir_from_env() -> Path:
    return Path(_require("AUTOLAB_STORAGE_DIR"))


def spool_from_env() -> Spool:
    default = Path.home() / ".autolab-spool"
    return Spool(Path(os.environ.get("AUTOLAB_SPOOL_DIR") or default))


def session_from_env(
    *,
    producer_id: _Id | None = None,
    run_id: _Id | None = None,
    setup_id: _Id | None = None,
    device_id: _Id | None = None,
) -> MeasurementSession:
    return MeasurementSession(
        client=client_from_env(),
        storage_dir=storage_dir_from_env(),
        spool=spool_from_env(),
        producer_id=producer_id or os.environ.get("AUTOLAB_ACTOR_ID") or None,
        run_id=run_id,
        setup_id=setup_id,
        device_id=device_id,
    )

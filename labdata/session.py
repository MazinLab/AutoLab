"""Measurement sessions: bind instrument saves to the active experiment.

A cooldown produces hundreds of files; requiring per-save bookkeeping means
the links never happen. Instead the instrument script declares its context
once — which experiment setup, which device, optionally which measurement
run — and every ``save`` during the session automatically carries
``refers_to`` links to that context alongside the usual ``produced_by``.

``ensure_measurement_run`` creates (idempotently) the run record itself with
its semantic edges: ``measured_in`` the setup, ``performed_on`` the device,
``produced_by`` the instrument.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Mapping

from labdata.client import LabData
from labdata.save import save
from labdata.spool import Spool

_Id = uuid.UUID | str


def ensure_measurement_run(
    client: LabData,
    name: str,
    *,
    source_key: str,
    setup_id: _Id | None = None,
    device_id: _Id | None = None,
    instrument_id: _Id | None = None,
    kind: str = "",
    body: str = "",
    extra: Mapping[str, object] | None = None,
) -> dict:
    """Create the measurement_run for a session, idempotently.

    Safe to call on every acquisition-script start: the source_key replays
    to the same record, and its provenance edges re-apply as no-ops.
    """
    links = []
    if setup_id is not None:
        links.append({"relation": "measured_in", "dst_id": str(setup_id)})
    if device_id is not None:
        links.append({"relation": "performed_on", "dst_id": str(device_id)})
    if instrument_id is not None:
        links.append({"relation": "produced_by", "dst_id": str(instrument_id)})
    payload: dict = {**(extra or {}), "name": name}
    if kind:
        payload["kind"] = kind
    if body:
        payload["body"] = body
    return client.create_entity(
        "measurement_run", payload, source_key=source_key, links=links
    )


@dataclass
class MeasurementSession:
    """Everything an instrument script needs to save linked data.

    ``run_id``/``setup_id``/``device_id`` become ``refers_to`` links on every
    artifact saved through the session; ``producer_id`` (instrument or agent)
    becomes ``produced_by``.
    """

    client: LabData
    storage_dir: Path
    spool: Spool
    producer_id: _Id | None = None
    run_id: _Id | None = None
    setup_id: _Id | None = None
    device_id: _Id | None = None
    extra_related_ids: tuple[_Id, ...] = field(default_factory=tuple)

    def context_ids(self) -> list[_Id]:
        bound = (self.run_id, self.setup_id, self.device_id)
        return [i for i in (*bound, *self.extra_related_ids) if i is not None]

    def start_run(
        self,
        name: str,
        *,
        source_key: str,
        kind: str = "",
        body: str = "",
        extra: Mapping[str, object] | None = None,
    ) -> dict:
        """Create (or replay) the session's measurement_run and bind it."""
        run = ensure_measurement_run(
            self.client,
            name,
            source_key=source_key,
            setup_id=self.setup_id,
            device_id=self.device_id,
            instrument_id=self.producer_id,
            kind=kind,
            body=body,
            extra=extra,
        )
        self.run_id = run["id"]
        return run

    def save(
        self,
        data: object,
        kind: str,
        name: str,
        *,
        related_ids: Iterable[_Id] = (),
        extra: Mapping[str, object] | None = None,
        subdir: str | Path = "",
    ) -> dict:
        return save(
            data,
            kind,
            name,
            self.storage_dir,
            self.client,
            self.spool,
            producer_id=self.producer_id,
            related_ids=[*self.context_ids(), *related_ids],
            extra=extra,
            subdir=subdir,
        )

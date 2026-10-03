from __future__ import annotations

import uuid
from types import TracebackType
from typing import cast

import httpx


class LabData:
    def __init__(
        self,
        http: httpx.Client,
        actor_id: uuid.UUID | str | None = None,
    ) -> None:
        self.http = http
        self.actor_id = actor_id

    @classmethod
    def for_url(
        cls,
        base_url: str,
        actor_id: uuid.UUID | str | None = None,
        timeout: float = 5.0,
    ) -> LabData:
        return cls(
            httpx.Client(base_url=base_url, timeout=timeout),
            actor_id=actor_id,
        )

    def close(self) -> None:
        self.http.close()

    def __enter__(self) -> LabData:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()

    def register_artifact(
        self,
        payload: dict,
        source_key: str,
        links: list[dict] | None = None,
    ) -> dict:
        """Register an artifact and its provenance edges in ONE transaction.

        Inline links close the crash window where the artifact commits but
        its edges don't; source_key replay re-applies them idempotently.
        """
        body = dict(payload)
        body["source_key"] = source_key
        if links:
            body["links"] = links
        response = self.http.post(
            "/api/artifact",
            json=body,
            headers=self._headers(),
        )
        response.raise_for_status()
        return cast(dict, response.json())

    def create_entity(
        self,
        entity_type: str,
        payload: dict,
        source_key: str | None = None,
        links: list[dict] | None = None,
    ) -> dict:
        """Create a catalog entity (with links) in one transaction.

        A source_key makes creation idempotent: instrument scripts can call
        this on every run start and always get the same record back.
        """
        body = dict(payload)
        if source_key is not None:
            body["source_key"] = source_key
        if links:
            body["links"] = links
        response = self.http.post(
            f"/api/{entity_type}",
            json=body,
            headers=self._headers(),
        )
        response.raise_for_status()
        return cast(dict, response.json())

    def add_edge(
        self,
        src_id: uuid.UUID | str,
        relation: str,
        dst_id: uuid.UUID | str,
    ) -> dict:
        response = self.http.post(
            "/api/edges",
            json={
                "src_id": str(src_id),
                "relation": relation,
                "dst_id": str(dst_id),
            },
            headers=self._headers(),
        )
        response.raise_for_status()
        return cast(dict, response.json())

    def _headers(self) -> dict[str, str] | None:
        if self.actor_id is None:
            return None
        return {"X-Actor-Id": str(self.actor_id)}

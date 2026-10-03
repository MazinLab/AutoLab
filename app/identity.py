"""Network identity resolution from tailscale serve headers or whois.

Attribution in AutoLab is a lab notebook signature, not an access control:
the resolved identity supplies the DEFAULT actor and is recorded as
``submitted_by`` metadata when someone deliberately acts as another person.
Nothing is enforced or rejected based on it.

Two resolution modes, both requiring the direct peer to be a trusted proxy:

- ``tailscale-serve``: trust the ``Tailscale-User-Login`` header injected by
  the tailscale serve proxy.
- ``tailscale-whois``: take the client address the proxy appended to
  ``X-Forwarded-For`` and, when it is a tailnet address, ask the local
  tailscaled's whois API who it is. This works behind any reverse proxy
  (Caddy, tailscale serve) and cannot be forged by clients: only the LAST
  forwarded hop — the one our own proxy appended — is consulted.
- ``tailscale-hybrid``: accept a verified Serve header when present and
  otherwise fall back to local whois. This supports independent Tailscale and
  Headscale proxies without weakening the trusted-direct-peer requirement.

Resolution lives in a pure ASGI middleware (not a dependency) because the
value travels to ``record_event`` through a ContextVar: the middleware's
set/reset happen in the request's async context, which sync endpoint
handlers inherit as a context copy in the threadpool. FastAPI sync
dependencies run setup and teardown in different contexts, so a dependency
cannot manage the ContextVar safely.
"""

from __future__ import annotations

import asyncio
import http.client
import ipaddress
import json
import socket
import time
import urllib.parse
import uuid

from fastapi import Request
from sqlmodel import Session, select

from labcore.events import reset_submitted_by, set_submitted_by
from labcore.models.entities import Person, PersonNetworkIdentity
from labcore.service import get_entity

LOGIN_HEADER = "Tailscale-User-Login"
FORWARDED_HEADER = "X-Forwarded-For"

_WRITE_METHODS = frozenset({"POST", "PATCH", "PUT", "DELETE"})

_TAILNET_NETWORKS = (
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("fd7a:115c:a1e0::/48"),
)

# Whois results per client IP; entries expire so login changes (device
# handed to another user, re-auth) surface within a minute.
_WHOIS_CACHE_TTL_S = 60.0
_whois_cache: dict[str, tuple[str | None, float]] = {}


def _header(scope: dict, name: bytes) -> str | None:
    for header_name, value in scope.get("headers", []):
        if header_name == name:
            return value.decode("latin-1") or None
    return None


def _whois_login(socket_path: str, client_ip: str) -> str | None:
    """Ask the local tailscaled who a tailnet address belongs to.

    Any failure (tailscaled down, unknown peer, tagged node without a user)
    resolves to None — identity is best-effort by design.
    """

    class _UnixConnection(http.client.HTTPConnection):
        def __init__(self) -> None:
            super().__init__("local-tailscaled.sock", timeout=1.0)

        def connect(self) -> None:
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(1.0)
            sock.connect(socket_path)
            self.sock = sock

    connection = _UnixConnection()
    try:
        connection.request(
            "GET",
            f"/localapi/v0/whois?addr={urllib.parse.quote(client_ip)}",
        )
        response = connection.getresponse()
        if response.status != 200:
            return None
        payload = json.loads(response.read())
    except (OSError, ValueError):
        return None
    finally:
        connection.close()
    profile = payload.get("UserProfile") or {}
    login = profile.get("LoginName")
    return login if isinstance(login, str) and login else None


def _tailnet_login(settings, forwarded_for: str) -> str | None:
    # Only the last hop is trustworthy: our proxy appended it, while any
    # earlier entries arrived from the client and can be forged.
    candidate = forwarded_for.rsplit(",", 1)[-1].strip()
    try:
        address = ipaddress.ip_address(candidate)
    except ValueError:
        return None
    if not any(address in network for network in _TAILNET_NETWORKS):
        return None
    now = time.monotonic()
    cached = _whois_cache.get(candidate)
    if cached is not None and cached[1] > now:
        return cached[0]
    login = _whois_login(settings.identity_whois_socket, candidate)
    _whois_cache[candidate] = (login, now + _WHOIS_CACHE_TTL_S)
    return login


def _login_from_scope(scope: dict) -> str | None:
    app = scope.get("app")
    if app is None:
        return None
    settings = app.state.settings
    client = scope.get("client")
    if client is None or client[0] not in settings.identity_trusted_proxies:
        return None
    if settings.identity_mode in {"tailscale-serve", "tailscale-hybrid"}:
        login = _header(scope, b"tailscale-user-login")
        if login is not None or settings.identity_mode == "tailscale-serve":
            return login
    if settings.identity_mode in {"tailscale-whois", "tailscale-hybrid"}:
        forwarded = _header(scope, b"x-forwarded-for")
        if forwarded is None:
            return None
        return _tailnet_login(settings, forwarded)
    return None


def resolve_login(request: Request) -> str | None:
    """Return the Tailscale login for this request, if trustworthy.

    The header is honored only when identity_mode enables it AND the direct
    peer is the trusted reverse proxy — anything else (direct connections,
    dev mode, tests without opt-in) resolves to None.
    """
    return _login_from_scope(request.scope)


def person_for_login(session: Session, login: str) -> dict | None:
    """Return the full entity dict of the person linked to a login."""
    identity = session.get(PersonNetworkIdentity, login)
    if identity is not None:
        return get_entity(session, identity.person_id)
    # Backward compatibility for databases that have not run the alias
    # backfill yet; migrated and newly-linked logins use the table above.
    row = session.exec(
        select(Person)
        .where(Person.tailscale_login == login)
        .order_by(Person.id)
    ).first()
    if row is None:
        return None
    return get_entity(session, row.id)


def person_id_for_login(session: Session, login: str) -> uuid.UUID | None:
    person = person_for_login(session, login)
    return person["id"] if person else None


def _is_cross_site(scope: dict) -> bool:
    """True for a browser write whose Origin is not this site.

    Identity comes from the network, not a cookie, so any page a tailnet
    user opens could otherwise submit a form (multipart uploads need no CORS
    preflight) that the app attributes to them. Requests without an Origin
    (scripts, instrument PCs, MCP clients) are not browser cross-site
    requests. "null" (sandboxed frames, file pages) never matches.
    """
    origin = _header(scope, b"origin")
    if origin is None:
        return False
    origin_host = urllib.parse.urlsplit(origin).netloc.lower()
    site_hosts = {
        value.lower()
        for value in (_header(scope, b"host"), _header(scope, b"x-forwarded-host"))
        if value
    }
    return origin_host not in site_hosts


async def _send_rejection(send, detail: str) -> None:
    body = json.dumps({"detail": detail}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": 403,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


class NetworkIdentityMiddleware:
    """Resolve the submitting person for write requests into the ContextVar.

    Reads never need it, so the person lookup (one indexed query on a short
    lived session) only runs for write methods with a resolvable login.
    """

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope.get("method") not in _WRITE_METHODS:
            await self.app(scope, receive, send)
            return

        if _is_cross_site(scope):
            await _send_rejection(send, "cross-site write rejected")
            return

        person_id: uuid.UUID | None = None
        # whois mode does blocking socket I/O; keep it off the event loop.
        login = await asyncio.to_thread(_login_from_scope, scope)
        settings = scope["app"].state.settings
        if settings.require_identity_for_writes and login is None:
            await _send_rejection(
                send,
                "read-only access: writes require a network-resolved "
                "identity (connect through the tailnet)",
            )
            return
        if login:
            with Session(scope["app"].state.engine) as session:
                person_id = person_id_for_login(session, login)
        token = set_submitted_by(person_id, login)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_submitted_by(token)

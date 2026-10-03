# Network identity and activity feed (2026-07-20)

- Tailscale identity: with `AUTOLAB_IDENTITY_MODE=tailscale-serve`, the
  `Tailscale-User-Login` header injected by the tailscale serve proxy (and
  trusted only from loopback) resolves a person via the new
  `person.tailscale_login` mapping. That person becomes the default actor
  for writes when no `X-Actor-Id` is supplied; the explicit header still
  wins, so acting as a colleague keeps working. When the chosen actor
  differs from the resolved submitter, the event records `submitted_by`
  in its payload. Nothing is enforced — attribution stays a lab notebook
  signature.
- `GET /api/whoami` reports the resolved login and person. The frontend
  actor picker defaults to "you", shows an acting-as note when overridden,
  and offers a one-click link of an unmapped login to the selected person
  (one login maps to at most one person; collisions are rejected).
- New Activity page (left nav "Activity") listing catalog creations and
  updates in reverse chronological order with day headers, entity links,
  accessions, and actors; backed by `GET /api/feed`, a hydrated,
  cursor-paginated, newest-first event feed.
- Decision: the catalog starts from a clean slate — no historical elog
  import. The importer remains available but unused.

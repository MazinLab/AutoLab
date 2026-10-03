# Security and data-integrity review fixes (2026-07-20)

- File-backed SQLite now uses per-connection pooling with a busy timeout;
  concurrent API writes can no longer interleave transactions and silently
  lose acknowledged rows (StaticPool remains for in-memory test DBs).
- A spool journal failure no longer deletes the completed acquisition file:
  `labdata.save` preserves the data, writes a recovery sidecar, and raises
  `SpoolJournalError` with the paths needed for manual repair.
- Artifact registration rejects URIs outside the storage root and validates
  checksum syntax (64 hex chars) and non-negative sizes.
- Artifact downloads are always served as attachments with `nosniff` and a
  sandbox CSP, so cataloged HTML/SVG cannot execute under the AutoLab origin.
- MCP `query_sql` is now time-bounded (SQLite progress handler, Postgres
  `SET LOCAL statement_timeout`) and byte-bounded (per-cell and per-response
  truncation with a `truncated` flag).
- MCP `summarize_array` rejects HDF5 external links and virtual datasets
  that would read files outside the storage root.
- Structural provenance edges that would create a cycle are rejected; an
  entity never appears in its own lineage even with legacy cycles; lineage
  depth is capped (≤64) at the API boundary.
- Entity creates reject server-assigned identity fields (`id`, `accession`,
  `version`, ...) instead of silently storing them in `extra`; database
  constraint violations return 409 instead of 500; the global events feed and
  MCP `get_events` reject timezone-naive cursors with 422 like the
  entity-scoped feed.
- `/api/search` matches accession codes, so `[[W-2026-0001]]` references
  resolve.
- Docker image now builds the frontend, includes `labdata`, and compose
  mounts a shared artifact store, publishes Postgres on loopback for
  backups, and runs a periodic watcher service (not yet smoke-tested —
  no Docker on the dev Mac).

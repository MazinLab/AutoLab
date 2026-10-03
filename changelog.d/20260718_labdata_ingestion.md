# 2026-07-18 Artifact and labdata ingestion

Entity creation now supports idempotent `source_key` replay. Artifacts include
schema versions and roles, protect ingested raw data from mutation, support
immutable replacement through `SUPERSEDES` provenance, and can be downloaded
from configured storage. The new `labdata` client writes HDF5 or Parquet with a
checksum and catalog registration, backed by a durable offline spool: network
failures and 5xx/429 responses stay queued for `flush()` to retry, while other
HTTP responses, including 4xx rejections, move to `dead/`. `save()` returns a
permanent registration error in its result, while `flush()` logs and skips the
dead-lettered entry. A storage scan creates idempotent review tasks for
unregistered files and resolves them after artifact registration.

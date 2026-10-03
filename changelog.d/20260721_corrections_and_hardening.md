## Corrections, atomic provenance, and integrity hardening (2026-07-21)

Records and links are now correctable: DELETE endpoints for entities and
edges (event feed keeps "deleted"/"unlinked" tombstones; actors with
history are protected), with an entity-page danger zone, per-edge Unlink
chips, and an Add link form — all two-step inline confirms. Creates are
atomic: the `links` payload key writes the record and its edges in one
transaction (UI forms, quick-note `[[mentions]]` — now resolved even when
typed by hand — labdata, and spool replay all use it).

Artifact integrity: registration by URI verifies declared checksum/size
against the stored bytes; UI uploads are role=raw (immutability guard
armed), size-capped, and deduplicated by content hash; downloads stream
from an O_NOFOLLOW-opened descriptor, closing the symlink race. The
watcher scan dropped from O(files x artifacts) to one snapshot per scan.

Search now matches notebook body text and returns snippets. Entity lists
gained server-side filters/pagination (browse and the review queue no
longer download whole tables or the event log); the activity feed gained
action/type/actor filters and renders deletion tombstones. MCP gained
agent-attributed create/update/link tools plus HDF5 external-storage
rejection and stricter resource budgets. New /api/health endpoint;
compose ships Tailscale identity enabled with a pinned network gateway;
destructive migrations refuse populated databases without explicit opt-in.

Offline: catalog reads are service-worker cached, and a create that fails
offline is queued (with accession-based links) and synced automatically on
reconnect — a visible outbox indicator shows pending records. Plus: entity
editor preserves booleans and validates numbers inline, a hint when no
label printer is configured, browser theme-color follows the active theme,
and brighter Litho text.

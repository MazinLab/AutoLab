# 2026-07-19 Operations, backfill, and legacy elog import

AutoLab now imports legacy elog JSONL idempotently by content hash, attributes
authors through person entities, maps entry types to note templates, preserves
source metadata, and links notes to their threads and logbook instruments. The
API adds UUID registry resolution and per-entity event history so the frontend
no longer scans the global event feed for entity pages.

Production operations now include structured JSON application logging, a
dedicated SELECT-only Postgres role for MCP SQL queries, dated backup retention,
a confirmation-gated clean restore, and an automated CI restore round trip.
Runbooks document the Ubuntu backup schedule, restore procedure, read-only role,
logging behavior, and elog re-export and attachment-migration prerequisites.
Live restore acceptance on the lab server and the required exoserver re-export
with attachments remain outstanding.

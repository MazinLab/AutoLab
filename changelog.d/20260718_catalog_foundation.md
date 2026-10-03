# 2026-07-18 Catalog foundation

Entity registry with UUIDv7 identity, accession codes, and actor
attribution, 17 v1 entity tables with JSON/JSONB extra-field overflow,
provenance edges with structural lineage traversal, an append-only event
log with cursor pagination, and a FastAPI CRUD/lineage/search/events API.
SQLite in development, Postgres 17 via Alembic migrations in the container
deployment.

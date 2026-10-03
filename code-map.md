# AutoLab code map

## `labcore/`

- `labcore/__init__.py` — package marker.
- `labcore/accession.py` — entity-type prefixes, per-type/year accession counters, and accession generation.
- `labcore/db.py` — SQLModel engine construction, including SQLite pooling and foreign-key setup, plus database-enforced read-only connections.
- `labcore/events.py` — JSON normalization, transactional event recording, and `(timestamp, UUID)` cursor queries.
- `labcore/labelprint.py` — QR and text-only Zebra Programming Language rendering.
- `labcore/lineage.py` — provenance-edge creation, recursive structural lineage traversal, and graph-shaped lineage projection.
- `labcore/lineage_label.py` — deterministic dotted display labels derived from the primary `DERIVED_FROM` ancestry chain; labels are never stored or treated as identifiers.
- `labcore/models/__init__.py` — public model and registry exports.
- `labcore/models/base.py` — UUIDv7 and UTC helpers, JSON/JSONB type variant, UTC datetime type, and entity registry.
- `labcore/models/edges.py` — relation enum and `ProvenanceEdge` table.
- `labcore/models/entities.py` — typed entity mixin, 17 entity tables, artifact roles and metadata, and the `ENTITY_TYPES` registry.
- `labcore/models/events.py` — append-only `Event` table.
- `labcore/schema_doc.py` — database-derived table and column documentation for the MCP schema surface.
- `labcore/service.py` — registry-backed entity create/read/update/list operations, source-key idempotency, typed validation, extra-field storage, actor validation, optimistic version checks, raw-artifact immutability, and artifact supersession.

## `labdata/`

- `labdata/__init__.py` — public `LabData`, `Spool`, and `save` exports.
- `labdata/client.py` — HTTP catalog client for artifact registration and provenance links, with optional actor attribution.
- `labdata/save.py` — one-call HDF5/Parquet writing, checksumming, write-ahead journaling, and catalog registration with retry/dead-letter handling.
- `labdata/spool.py` — durable write-ahead registration queue, retryable flush, dead-letter handling, and malformed-entry quarantine.

## `app/`

- `app/__init__.py` — package marker.
- `app/api/__init__.py` — API package marker.
- `app/api/artifacts.py` — artifact registration, download, and supersede routes.
- `app/api/entities.py` — transaction-scoped sessions, actor-header parsing, entity CRUD routes, accession resolution, version ETags, and `If-Match` optimistic concurrency.
- `app/api/labels.py` — configured-printer discovery, QR/text ZPL construction and raw-TCP delivery, and post-send `label_printed` event recording.
- `app/api/lineage.py` — provenance-edge input model, edge creation route, up/down lineage route with `graph` and relation-filter query parameters, and derived-label retrieval.
- `app/api/meta.py` — event-feed cursor parsing, event route, entity JSON-schema/relations route, and the `/api/templates` capture-template route.
- `app/api/search.py` — case-insensitive cross-entity name/description search with deterministic ordering.
- `app/artifact_paths.py` — storage-root containment checks for artifact URI resolution.
- `app/config.py` — `AUTOLAB_` settings, including database URL, read-only database URL, JSON logging toggle, artifact storage root, and built-frontend path.
- `app/data/templates.json` — note, fab-step, and cooldown capture-form definitions served to the frontend.
- `app/importers/__init__.py` — legacy and external data-import package marker.
- `app/importers/elog.py` — validated JSONL elog import with content-hash idempotency, person attribution, template mapping, and thread/instrument provenance links.
- `app/logging_config.py` — plain or structured-JSON application logging setup with serialized exceptions.
- `app/mcp/__init__.py` — public MCP server-factory export.
- `app/mcp/annotation_tools.py` — agent-attributed annotation proposals as review tasks with `ANNOTATES` target and `REFERS_TO` evidence links.
- `app/mcp/artifact_tools.py` — bounded text-artifact reads and dtype-aware HDF5/Parquet array summaries, including complex-data magnitude and component statistics.
- `app/mcp/server.py` — FastMCP factory, schema description, read-only SQL, event-feed tools, and supporting-tool registration.
- `app/main.py` — FastAPI app factory, engine setup, router registration, MCP mount/lifespan wiring, built-SPA static-file serving, and SPA deep-link fallback.
- `app/watcher.py` — storage scan for unregistered files, idempotent review-task creation, and review-task resolution after artifact registration.

## `frontend/`

- `frontend/package.json` and `frontend/package-lock.json` — React/Vite runtime, unit-test, PWA, scanner, and Playwright dependencies and commands.
- `frontend/vite.config.ts` — React build, development API proxy, Vitest environment, and installable PWA manifest/service worker.
- `frontend/playwright.config.ts` — local live-server Chromium smoke configuration using `AUTOLAB_BASE_URL`.
- `frontend/e2e/` — Playwright coverage for template note capture, fab-step logging, and manual accession navigation.
- `frontend/public/` — PWA application icons.
- `frontend/src/App.tsx` and `frontend/src/main.tsx` — browser entry point and client-side routes.
- `frontend/src/api/` — typed same-origin catalog client with actor attribution, printer discovery and label-print requests, lineage/template requests, and ETag/If-Match handling.
- `frontend/src/components/PrintLabel.tsx` — entity-page printer/format picker and manual reprint control.
- `frontend/src/components/` — actor selection, template capture, and lineage graph components.
- `frontend/src/pages/browse/` and `frontend/src/pages/entity/` — catalog search, accession resolution, record detail, lineage, files, notes, and events.
- `frontend/src/pages/new/`, `frontend/src/pages/notes/`, and `frontend/src/pages/queue/` — template entry, quick notes, and review-task workflows.
- `frontend/src/pages/scan/`, `frontend/src/pages/mount/`, and `frontend/src/scanner/` — camera/manual accession entry and two-scan cooldown mounting flows.
- `frontend/src/pages/capture.css` — shared template-capture and review-action styling.
- `frontend/src/shell/` and `frontend/src/styles.css` — responsive application shell, navigation, actor control, and shared styling.

## `tests/`

- `tests/__init__.py` — test package marker.
- `tests/conftest.py` — test-engine (SQLite by default), SQLModel session, and FastAPI client fixtures.
- `tests/test_accession.py` — accession sequencing, counter isolation, unknown types, and prefixes.
- `tests/test_api_entities.py` — entity CRUD, accession resolution, pagination, type checks, and actor headers.
- `tests/test_api_lineage_search.py` — edge/lineage routes, validation, cross-type search, and global ordering.
- `tests/test_api_meta.py` — event feed, cursor pagination, malformed cursors, and schema relations.
- `tests/test_etag.py` — entity version ETags and `If-Match` optimistic concurrency.
- `tests/test_entities.py` — registry/entity-table integration and construction of every entity type.
- `tests/test_events.py` — write events, actor/payload data, idempotent links, rollback, and cursor traversal.
- `tests/test_fix_r1_2.py` — typed coercion/validation, required fields, extra fields, and atomic update rejection.
- `tests/test_fix_r1_5_lineage_depth.py` — zero and negative lineage-depth behavior.
- `tests/test_fix_r1_1_static_files.py` — PWA static files and SPA fallback responses.
- `tests/test_fix_r1_6_lineage_relations.py` — lineage relation filtering and graph responses.
- `tests/test_fix_search_ordering.py` — per-type ordering before applying the search limit.
- `tests/test_fix_tz_aware.py` — UTC-aware event loads and event cursors.
- `tests/test_lineage.py` — structural/non-structural relations, directions, depth, duplicate edges, and endpoint checks.
- `tests/test_lineage_graph.py` — graph-shaped lineage nodes and traversed edges.
- `tests/test_registry.py` — UUIDv7/time helpers, UTC datetime behavior, and foreign-key enforcement.
- `tests/test_scaffold.py` — package imports.
- `tests/test_service.py` — service lifecycle, accessions, extra fields, actor attribution, validation, and type-safe updates.
- `tests/test_templates_static.py` — capture-template endpoint and template-definition validation.

## `alembic/`

- `alembic/README` — generic single-database Alembic configuration note.
- `alembic/env.py` — offline/online migration environment using SQLModel metadata.
- `alembic/script.py.mako` — migration-file template.
- `alembic/versions/2f201cef15a3_initial_schema.py` — initial schema migration for registries, entity tables, edges, events, and accession counters.
- `alembic/versions/6c7a9e4b2d10_artifact_idempotency.py` — source-key idempotency index and artifact schema-version migration.
- `alembic/versions/d9c1a4e7b203_entity_registry_version.py` — optimistic-lock version column for entity registry rows.

## `scripts/`

- `scripts/backup.sh` — dated custom-format Postgres backups with count-based retention.
- `scripts/restore.sh` — confirmation-gated, clean, single-transaction Postgres restore with a noninteractive CI mode.

## `compose/initdb/`

- `compose/initdb/01_readonly_role.sql` — initial Postgres provisioning for the SELECT-only `autolab_ro` login role and future-table privileges.

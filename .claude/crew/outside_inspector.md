# Outside Inspector Focus Text — AutoLab (adversarial reviewer)

This file is read by the orchestrator to build the adversarial review focus
text. It configures an external model review invoked at high reasoning effort.

## Goal

Find real, evidence-backed correctness problems introduced by this build's
diff. Every finding must cite a file and line from the diff and survive an
adversarial re-check — each bug claim you report is independently verified by
a skeptic who reads the same code, so speculative or padded findings only
waste the pipeline's time. An empty array is the correct, complete answer for
a clean diff.

## Architecture Concerns

<!-- customizer: replace with this project's domain context -->
AutoLab is the lab data catalog, ELN, and provenance system for the Mazin Lab (UCSB), which builds MKID (microwave kinetic inductance detector) arrays for astrophysics.

**Stack:** Python 3.13, SQLModel (SQLAlchemy 2 + Pydantic v2), FastAPI, and Alembic; SQLite in-memory for tests, Postgres 17 in production.

### Core data model

- One `entity_registry` table anchors every entity: UUIDv7 primary key, unique human accession code (e.g. `W-2026-0001`, `DEV-2026-0417`), `entity_type`, `created_by_id` (actor attribution: a person or agent entity).
- 17 typed entity tables (`project`, `person`, `agent`, `instrument`, `design_revision`, `mask_set`, `fab_run`, `fab_step`, `wafer`, `die`, `device`, `cooldown`, `measurement_run`, `analysis_run`, `artifact`, `note`, `review_task`), whose primary key is a foreign key to `entity_registry.id`.
- `provenance_edge` rows read `src RELATION dst` (`device DERIVED_FROM wafer`, `device MEASURED_IN cooldown`). Lineage is a recursive CTE with depth capped.
- An append-only `event` table is written in the SAME transaction as every catalog write (created/updated/linked). Events are never updated or deleted.

### Invariants

- Identity is the opaque UUIDv7; accession codes are generated for humans and **NEVER** parsed as a source of truth.
- Relationships are database rows, never filename or string conventions.
- Unknown payload fields must overflow into the per-entity `extra` JSON column (JSONB on Postgres via type variant), never be silently dropped.
- All datetimes are timezone-aware UTC. Physical units live in field names (`base_temp_mk`, `diameter_mm`).
- Raw artifacts are immutable after ingestion; corrections create new versions linked by supersedes edges.

### Known pitfalls

- SQLModel `table=True` classes skip Pydantic validation on construction; the service layer splits payloads explicitly instead of trusting validation.
- SQLAlchemy `Column` objects cannot be shared across tables; shared mixins use `sa_type` with a shared type INSTANCE (`JSON().with_variant(JSONB, ...)`).
- SQLite does not enforce foreign keys by default and `with_for_update` is a no-op there; concurrency guarantees are Postgres-only and tests must not assume FK violations fire on SQLite.
- FastAPI matches routes in registration order: specific routers (lineage, search, meta) **MUST** be included before the generic `/{entity_type}` router.
- The dev Mac has no Docker: the test suite must stay green on SQLite; never add a test that requires a live Postgres.

### Conventions

- Type hints on all signatures.
- `pathlib` for paths.
- `logging` (not `print`) in library code.
- f-strings.
- `pytest` in `tests/`, mirroring source.
- Conda environment `py313` (`conda run -n py313 python` / `conda run -n py313 pytest`).

Key correctness invariants to enforce:
- Throughput or efficiency values must be in [0, 1] — never negative, never > 1
- Additive error or variance components must stack in quadrature (sqrt of sum of
  squares), not linearly, unless you can prove linear stacking is correct
- Cache key derivation: modules must NOT define their own cache-key logic if the
  project has a shared cache layer — only the cache layer does this
- Data contract declarations must be complete — any state key read/written but
  not declared is a bug
- RNG derivation: must be deterministic — same seed + same context → same stream
  regardless of parallelism

## Review Focus

Priority areas for adversarial review:
- **Domain correctness**: wrong unit conversions, incorrect array axis conventions,
  matrix transpose errors, incorrect error stacking (linear instead of quadrature)
- **Contract violations**: a module reads a data field not in its declared consume
  set, or writes a field not in its declared produce set
- **Cache bypass bugs**: any code that derives or checks cache keys inside a
  domain component (should not exist — cache layer owns this)
- **Silent data corruption**: NaN propagation through calculations, zero-division
  without guard, values silently clamped to wrong range
- **API contract violations**: caller passes wrong types, missing error handling
  at system boundaries (config parsing, numpy operations on mismatched shapes)
- **Stale imports from moved/renamed functions**: active development means symbols
  may move between modules
- **Missing edge-case handling**: empty input arrays, zero-length grids, boundary
  parameter values, degenerate configurations

## What NOT to Review

These are handled by other agents — do not duplicate their work:
- Style and naming issues (handled by Tidier)
- Missing tests (handled by Test Developer)
- Documentation gaps (handled by Librarian)
- Import ordering (handled by Tidier)

Also out of scope: hypothetical edge cases the code cannot actually hit, and
pre-existing issues not introduced by this diff.

## Severity Guidance

Map your findings to these severity levels:
- **critical/high → bug**: wrong domain output, crash, silent data corruption — MUST fix before commit
- **medium → design**: correct but fragile, misplaced, architecturally inconsistent — fix soon
- **low → trivial**: minor inefficiency, documentation gaps — fix at convenience

## Output format
Return a JSON array of findings:
```json
[
  {
    "severity": "critical|high|medium|low",
    "file": "path/to/file.py",
    "line": 42,
    "description": "what is wrong",
    "suggested_fix": "how to fix it"
  }
]
```
If no issues found, return an empty array: []

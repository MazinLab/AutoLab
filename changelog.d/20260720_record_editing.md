# Record editing (2026-07-20)

- Every entity page has an Edit button opening a schema-driven editor: typed
  columns render as the right input (text, number, datetime), description as
  a textarea, and note bodies through the markdown toolbar editor. Scalar
  extra fields are editable and new fields can be added (overflowing into
  extra as usual).
- Saves patch only the changed fields with the loaded ETag; a concurrent
  change elsewhere is refused with a clear reload message instead of a
  silent overwrite. Every save is an append-only `updated` event carrying
  the patch, so full history is preserved while the page shows the latest
  version.
- Registry identity fields are never editable, and artifact integrity
  fields (uri, checksum, size) are excluded — corrections to raw artifacts
  still go through supersedes.

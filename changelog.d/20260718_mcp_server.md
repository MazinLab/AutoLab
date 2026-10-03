# 2026-07-18 MCP server

The FastAPI process now serves a streamable HTTP MCP endpoint at `/mcp` with
six tools for schema discovery, read-only SQL, event polling, text-artifact
reads, HDF5/Parquet summaries, and agent-attributed annotation proposals.
`query_sql` enforces read-only access, including SQLite authorizer hardening.
`summarize_array` reports dtype-aware statistics; complex data gets magnitude
and real/imaginary component statistics. Proposed judgment is recorded as a
review task with an `ANNOTATES` link to its target and `REFERS_TO` links to
evidence. The Docker image installs `.[labdata]` for HDF5 and Parquet support.

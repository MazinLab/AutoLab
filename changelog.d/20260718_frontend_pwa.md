# 2026-07-18 Frontend PWA

AutoLab now includes a responsive React/Vite PWA for catalog browsing, entity
lineage and activity, template-driven record capture, quick notes, review
queues, QR/manual accession entry, and cooldown mounting. A local live-server
Playwright gate protects note-template, fab-step, and manual-accession flows,
while CI builds the frontend and runs its Vitest suite.

The API also exposes graph-shaped lineage responses with relation filtering,
version ETags with `If-Match` optimistic concurrency, and capture templates at
`/api/templates`; FastAPI serves the built app shell and SPA deep links.

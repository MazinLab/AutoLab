# 2026-07-18 Edge idempotency race and search wildcard fixes

`add_edge` now uses an atomic `INSERT .. ON CONFLICT DO NOTHING` so
concurrent identical link requests both succeed (one inserts, the other
returns the existing edge; the linked event fires only for the inserted
row). `/api/search` escapes LIKE metacharacters, so `%` and `_` in the
query match literally instead of acting as wildcards.

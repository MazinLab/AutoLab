## Adversarial review hardening (2026-08-08)

From a comprehensive GPT-5.6-sol code review (22 findings, all valid; 19
patched, 3 filed as beads). Offline reliability: creates carry one stable
idempotency key from the first attempt through every replay (a committed
write whose response was lost can no longer duplicate); queueing verifies
persistence and keeps the draft on failure; a completing sync no longer
erases records queued mid-flight; replays run as the actor who authored
the record; server-rejected records dead-letter with copy-out recovery
instead of vanishing. Bench: failed photo uploads stay retryable without
recapturing; inputs lock during submission.

Integrity and security: upload dedup verifies the existing bytes before
discarding a new copy; upload writes use an O_NOFOLLOW descriptor walk;
oversized bodies are rejected before multipart parsing; concurrent
structural edges serialize on Postgres (advisory lock) so lineage cycles
cannot race in; MCP response caps apply to the first row; compose defaults
anonymous access to read-only; a database unique index backs tailscale
login mapping; verified-but-unmapped logins are recorded on events;
deletion tombstones survive the feed's type filter; an actor deleting
itself is a 409, not a 500; explicit `extra` objects merge as documented;
activity date filters use local calendar days; clone/supersede preserves
extra-stored fields and instrument category; typeahead and QR picks
enforce the same semantic filters as the dropdown (and now autofill);
`labdata flush` exits nonzero when entries dead-letter or quarantine.

## Break-in round: creation flow, bench ergonomics, sessions (2026-08-08)

Creation: Device, Project, and Agent templates (devices — the objects that
get cooled and measured — were previously uncreatable from the UI); batch
"Copies" creation with numbered names; "Create another" now keeps the
form's values; Clone and Supersede actions on every record page prefill a
new form (supersede adds the edge atomically); every entity reference
field gets the QR scan button and a type-ahead search, not just the
newest-100 dropdown.

Bench ergonomics: one-tap "Take photo" camera capture on all attachment
controls; quick notes gain photo attachments and a markdown
toolbar/preview.

Instrument side: labdata measurement sessions — declare the experiment
setup and device once, and every save auto-links its artifact to that
context; `ensure_measurement_run` idempotently creates the run with
measured_in/performed_on/produced_by edges; AUTOLAB_* env configuration
and a `python -m labdata flush|status` CLI for spool operations.

Awareness: home page shows active experiment setups (no ended_at); the
Queue nav badge counts open review tasks; the activity feed takes a date
range (feed API gains since/until). Lineage API gains hydrate=true
(node display names inline), removing the entity page's per-node fetch
fan-out.

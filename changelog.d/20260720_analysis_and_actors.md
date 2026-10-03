## Analyses, analysis software, and self-serve actors (2026-07-20)

Two new Testing templates: Analysis (AR records with a markdown results body,
attachments, a git commit field, and dropdowns linking `derived_from` an
experiment log and `refers_to` the software used) and Analysis Software (a new
`software` entity type, SW accessions, with version/git commit/URL fields and
code-archive uploads). Both appear in the Browse testing panel. Analyses join
lineage as structural ancestry, ready for future automated/LLM analyzers
writing through the same API as agent actors.

The actor dropdown gained "+ Add a person…", which deep-links to a new Person
template (name, email, Tailscale login) on the New Record page; a person
created through that flow is adopted as the active actor automatically. The
sidebar now reads "Mazin Lab Archive", and /new supports ?template= deep
links.

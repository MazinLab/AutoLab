# Fab recipes and wafer-anchored fab steps (2026-07-20)

- New `fab_recipe` entity type (accession RCP, migration d4e9a1c6f803) with
  a Fab Recipe template: recipe name, description, markdown procedure body
  (rendered on its entity page), and attachments. Recipes are reusable
  records selectable from fab steps.
- Fab Step reworked: a required recent-first Wafer dropdown replaces the
  fab run search box, plus optional Recipe and Machine dropdowns — the step
  links to all three by edges. `fab_step.fab_run_id` is now optional; fab
  runs remain as campaign groupings (Fab Note still uses them).

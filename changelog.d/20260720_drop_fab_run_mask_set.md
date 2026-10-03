# fab_run and mask_set removed (2026-07-20)

- Both entity types are gone (migration a7b4d2e8c135 drops the tables,
  purges their rows/edges/events, and removes `fab_step.fab_run_id`).
  Masks live in Design records; fab steps and fab notes anchor to the
  wafer being processed (Fab Note's fab run field is now a required
  recent-first Wafer dropdown).
- With every template picker now a dropdown, the unused search-box picker
  and foreign-key persistence path were deleted from the form code.

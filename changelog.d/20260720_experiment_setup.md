# Experiment Setup replaces Run Setup + Cooldown; Wafer Measurement template (2026-07-20)

- The cooldown entity and the Run Setup note template are combined into one
  `experiment_setup` type (migration b9c6e3f1d247 renames the table, adds a
  markdown body; CD accessions stay valid, new ones are ES-). One form at
  session start: title, instrument, start time, optional base temperature,
  loadout markdown, and attachments. Works for fridge runs and room
  temperature sessions alike; Experiment logs pick it from a Setup dropdown,
  and the mount flow now creates/chooses setups.
- New Wafer Measurement template (fab column, after Fab Note) on
  `measurement_run` (which gains a body column, migration c3a5d7f9b461):
  title, wafer, instrument, measurement kind, markdown summary, and file
  uploads for SEM/optical images, dektak thickness, resistivity maps, XRD.

# Wafer pages show the fab flow

A wafer's page now opens with **Fab flow**: its steps in step-index order,
each showing the recipe that was run, the machine, the date, and the run
notes, with a link through to the step and to the recipe. Steps no longer
appear as a bag of `STEP-2026-…` codes under Related records, and
"+ Add step" opens a Fab Step form with the wafer already picked and the
next step index filled in.

Record pickers throughout the app now list records by name instead of
accession code; the code only appears when a record has no name. Related
records lead with the name too, with the type and accession beneath.

New endpoint `GET /api/entities/{id}/fab_flow` resolves the ordered steps
with their recipe and machine in one query.

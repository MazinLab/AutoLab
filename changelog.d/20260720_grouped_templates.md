# Themed template columns and a Wafer template (2026-07-20)

- The New record page splits templates into two themed columns inside
  rounded colored panels: Fab (warm) — Wafer, Fab Recipe, Fab Step, Fab
  Note, Maintenance, Fab Equipment — and Testing (green) — Experimental
  Equipment, Run Setup, Cooldown, Experiment. Grouping comes from a new
  `group` key in the template JSON.
- New Wafer template: wafer name, optional Design dropdown (linked
  `derived_from` so lineage labels chain design → wafer → device),
  material, and diameter (mm). Wafers auto-print a QR label at creation.
- Equipment templates accept photo attachments at registration (a new
  `attachments` template flag shows the drop zone without a markdown body);
  the machine photo renders inline on the instrument's page.

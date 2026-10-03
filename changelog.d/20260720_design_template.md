# Design entity type and template (2026-07-20)

- `design_revision` renamed to `design` (migration e5f2b8d4a917 renames the
  table and rewrites registry/counter type strings; existing DSN accessions
  stay valid). The Wafer template's Design dropdown now targets it.
- New Design template at the top of the fab column: design name,
  description, git commit or tag, layout tool, plus arbitrary file uploads
  (GDS, mask files, code archives) via the attachment drop zone. Wafers
  derive from designs, so the lineage label chain starts here.

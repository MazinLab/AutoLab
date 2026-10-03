# Substrate batches (2026-07-20)

- New `substrate_batch` entity type (accession SUB, migration f6a3c9e5b028):
  vendor, material, diameter (mm), thickness (µm), resistivity, orientation,
  spec, wafer count, plus data sheet uploads. The Substrate Batch template
  sits in the fab column and auto-prints a QR label at creation for the box.
- The Wafer form's Material field is replaced by a Substrate Batch dropdown
  with an in-form QR scanner (camera plus manual accession fallback):
  picking or scanning a batch autofills the wafer's diameter and carries the
  batch material onto the wafer record, and links wafer → batch with a
  refers_to edge (label chain stays design → wafer → device).
- Entity pages gained a generic Details section showing all scalar typed and
  extra fields (vendor, thickness, spec...), which previously never appeared
  anywhere.

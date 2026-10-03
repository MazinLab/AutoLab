# Experiment form, markdown editor, and attachments (2026-07-20)

- Experiment template reworked: the Sample or Device field is now a dropdown
  of existing devices, dies, and wafers sorted newest first; the Hypothesis
  field is gone; Procedure is renamed Log Title and becomes the note's name
  directly.
- Markdown notes get a formatting toolbar (bold, italic, code, heading,
  lists, quote, link, table, code block) with a Write/Preview toggle backed
  by a safe hand-rolled markdown renderer (React elements only, no HTML
  injection). Note bodies on entity pages now render as markdown too.
- Attachments can be dropped (or browsed) onto any note template form; on
  submit each file uploads through the new `POST /api/artifacts/upload`
  multipart endpoint, which stores the file under the storage root, computes
  sha256/size server-side, registers the artifact, and links it to the new
  record with an `annotates` edge in one transaction. Failed uploads retry
  without recreating the record.
- Entity list API accepts `order=desc` for newest-first listings.

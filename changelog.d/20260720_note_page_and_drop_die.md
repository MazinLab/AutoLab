# Note pages show their content; die type removed (2026-07-20)

- An experiment or note's own markdown body now renders on its entity page
  (it was only shown for *related* notes before), and everything the record
  links to — sample, instrument, cooldown, fab run — appears in a new
  Related records section as clickable chips instead of raw UUIDs in the
  event feed.
- The `die` entity type is gone: devices derive directly from wafers.
  Migration `c8d1f0a37b52` drops the table and purges any die rows plus
  their edges and events; the Experiment sample dropdown now offers devices
  and wafers.

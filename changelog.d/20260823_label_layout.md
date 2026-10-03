# Labels fit the 2×1.25 in stock

The printed label was clipping its own accession — `W-2026-0001` came out
as `W-2026-000` — because the old layout started text 190 dots in and left
only 216 dots for it, with no wrapping anywhere.

The accession now gets a full-width line of its own under a rule, set a
real distance off the leading edge (the die-cut corners are rounded and
label-top registration drifts a few dots), and the record name wraps in the
printer with `^FB` instead of running off. `^PW`/`^LL` restate the media
size so a label renders the same on a printer whose stored settings differ.

Each label also carries its record's creation date in mm/dd/yy above a
small "Mazin Lab" mark, bottom right — enough to identify a wafer that
turns up loose in the cleanroom without scanning it. Dates print in lab
time (`AUTOLAB_LABEL_TIMEZONE`, default `America/Los_Angeles`): the server
stores UTC, so anything created after ~5pm Pacific would otherwise be
stamped with the following day.

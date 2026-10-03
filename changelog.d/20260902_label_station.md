# Label station at /labels

A standalone page for printing ad hoc labels on the lab Zebra, separate
from the catalog. It is unlinked from AutoLab and only exists for tailnet
visitors; from campus the path is a 404.

Two templates: **Computer ID** (hostname, MAC address, IP address, with
the MAC normalized to `AA:BB:CC:DD:EE:FF`) and **General** (title, body,
optional URL that prints as a QR code). The preview updates as you type
and is rendered by the same code that produces the printer's ZPL, so it
shows what will print. A checkbox adds the Mazin Lab badge, with a
position picker: left or right column on either template, plus small
top-right and bottom-right corners on General labels so a QR code and the
badge fit together. Copies 1 to 20; Cmd/Ctrl+Enter prints, plain Enter
never does.

New endpoints `POST /api/labels/render` and `POST /api/labels/print`.
New dependency: segno (QR encoding).

# Wafer and substrate-batch labels print themselves

Creating a wafer or a substrate batch spools its QR label automatically —
one per copy when you create a batch of them — as does a new piece of
equipment. This is not new behavior, but it had never actually printed:
until the ZD421t was configured there were no printers, so it silently
did nothing, and nothing in the test suite held it in place.

Devices no longer auto-print: a 2×1.25 in label does not fit a device box.
Print one on demand from the device's page if you want it.

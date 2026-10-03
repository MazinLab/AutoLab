"""Regenerate the 1-bit lab mark used on label-station labels.

Usage: python scripts/make_label_mark.py <logo.jpg|png>

Crops the artwork to its ink bounding box, downsamples to each size in
SIZES (132 dots fills a label column, 88 fits a corner beside a QR code),
and thresholds so thin ring lines stay connected. Writes the PBM the ZPL
^GFA field is built from and a PNG with white as transparency for the SVG
preview; both carry identical ink pixels. Pillow is only needed here,
never in the app.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageOps

# Smaller renderings need a higher threshold or the ring text breaks up.
SIZES = {132: 170, 88: 190}
OUT = Path(__file__).resolve().parent.parent / "labcore" / "assets"


def main(source: str) -> None:
    grey = Image.open(source).convert("L")
    ink = ImageOps.invert(grey).point(lambda v: 255 if v > 60 else 0)
    left, top, right, bottom = ink.getbbox()
    side = max(right - left, bottom - top)
    cx, cy = (left + right) // 2, (top + bottom) // 2
    square = grey.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))
    OUT.mkdir(exist_ok=True)
    for size, threshold in SIZES.items():
        bilevel = square.resize((size, size), Image.LANCZOS).point(
            lambda v, t=threshold: 0 if v < t else 255, "1"
        )
        bilevel.save(OUT / f"mazin_lab_mark_{size}.pbm")
        # Preview: ink opaque, paper transparent, like the printer.
        alpha = bilevel.convert("L").point(lambda v: 0 if v else 255)
        rgba = Image.new("RGBA", bilevel.size, (16, 24, 32, 0))
        rgba.putalpha(alpha)
        rgba.save(OUT / f"mazin_lab_mark_{size}.png", optimize=True)
        print(f"wrote mazin_lab_mark_{size}.{{pbm,png}} (threshold {threshold})")


if __name__ == "__main__":
    main(sys.argv[1])

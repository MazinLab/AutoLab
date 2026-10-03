from __future__ import annotations

# 2.0 x 1.25 in stock at 203 dpi. The layout is expressed in dots against
# these bounds, and ^PW/^LL restate them so a label renders the same on a
# printer whose stored media settings differ.
LABEL_WIDTH_DOTS = 406
LABEL_HEIGHT_DOTS = 254
MARGIN_DOTS = 14
# Vertical rhythm. The header sits a real distance off the leading edge:
# the die-cut corners are rounded and label-top registration moves by a few
# dots, so text hard against the edge reads as a printing mistake.
HEADER_TOP_DOTS = 24
ACCESSION_HEIGHT_DOTS = 38
RULE_Y_DOTS = 70
BODY_TOP_DOTS = 80
# QR magnification 4 puts a version-4 symbol at 132 dots (~0.65 in) and
# leaves the unprinted label around it as the quiet zone.
QR_MAGNIFICATION = 4
QR_SIZE_DOTS = 132
TEXT_COLUMN_X = MARGIN_DOTS + QR_SIZE_DOTS + 14
TEXT_COLUMN_WIDTH = LABEL_WIDTH_DOTS - MARGIN_DOTS - TEXT_COLUMN_X
# ^FB wraps the human line at word boundaries in the printer, so a long name
# stacks instead of running off the edge (the old layout clipped it, and
# clipped the accession with it). The line budget stops the name growing
# into the date and lab mark below it.
HUMAN_LINE_MAX_LINES = 3
TEXT_FORMAT_MAX_LINES = 2
# Creation date, sitting just above the lab mark.
DATE_Y_DOTS = 190
# Ownership mark: a wafer box that turns up loose in the cleanroom should say
# whose it is without anyone having to scan it. Bottom right, clear of the
# header — a long accession (STEP-2026-0014) would collide up there.
LAB_NAME = "Mazin Lab"
LAB_NAME_Y_DOTS = 216


def render_zpl(
    accession: str,
    qr_url: str,
    human_line: str,
    label_format: str = "qr",
    created_date: str = "",
) -> str:
    """Render a QR or text-only label as Zebra Programming Language.

    ``created_date`` is pre-formatted by the caller, which owns the lab
    timezone; this module stays pure layout.
    """
    if label_format not in {"qr", "text"}:
        raise ValueError(f"Unknown label format: {label_format}")

    safe_human_line = human_line.replace("^", " ").replace("~", " ")
    commands = [
        "^XA",
        "^CI28",
        f"^PW{LABEL_WIDTH_DOTS}",
        f"^LL{LABEL_HEIGHT_DOTS}",
    ]
    full_width = LABEL_WIDTH_DOTS - 2 * MARGIN_DOTS

    if label_format == "qr":
        # The accession owns a full-width line of its own: it is the one
        # field that must never be truncated.
        commands.extend(
            [
                f"^FO{MARGIN_DOTS},{HEADER_TOP_DOTS}"
                f"^A0N,{ACCESSION_HEIGHT_DOTS},{ACCESSION_HEIGHT_DOTS}"
                f"^FD{accession}^FS",
                f"^FO{MARGIN_DOTS},{RULE_Y_DOTS}^GB{full_width},2,2^FS",
                f"^FO{MARGIN_DOTS},{BODY_TOP_DOTS}^BQN,2,{QR_MAGNIFICATION}"
                f"^FDMA,{qr_url}^FS",
                f"^FO{TEXT_COLUMN_X},{BODY_TOP_DOTS + 2}^A0N,24,24"
                f"^FB{TEXT_COLUMN_WIDTH},{HUMAN_LINE_MAX_LINES},4,L"
                f"^FD{safe_human_line}^FS",
                f"^FO{TEXT_COLUMN_X},{DATE_Y_DOTS}^A0N,20,20"
                f"^FB{TEXT_COLUMN_WIDTH},1,0,R^FD{created_date}^FS",
                f"^FO{TEXT_COLUMN_X},{LAB_NAME_Y_DOTS}^A0N,20,20"
                f"^FB{TEXT_COLUMN_WIDTH},1,0,R^FD{LAB_NAME}^FS",
            ]
        )
    else:
        commands.extend(
            [
                f"^FO{MARGIN_DOTS},{HEADER_TOP_DOTS}^A0N,46,46"
                f"^FD{accession}^FS",
                f"^FO{MARGIN_DOTS},{RULE_Y_DOTS + 8}^GB{full_width},2,2^FS",
                f"^FO{MARGIN_DOTS},{BODY_TOP_DOTS + 8}^A0N,30,30"
                f"^FB{full_width},{TEXT_FORMAT_MAX_LINES},6,L"
                f"^FD{safe_human_line}^FS",
                f"^FO{MARGIN_DOTS},{DATE_Y_DOTS}^A0N,20,20"
                f"^FB{full_width},1,0,R^FD{created_date}^FS",
                f"^FO{MARGIN_DOTS},{LAB_NAME_Y_DOTS}^A0N,20,20"
                f"^FB{full_width},1,0,R^FD{LAB_NAME}^FS",
            ]
        )

    commands.append("^XZ")
    return "\n".join(commands)

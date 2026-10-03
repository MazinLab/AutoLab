"""Ad hoc label layouts for the label station.

One element list per label; ``to_zpl`` prints it and ``to_svg`` previews it,
so the two can only disagree where the printer's own word wrap differs from
the width estimate used here. Geometry is in dots on the 2.0 x 1.25 in stock
at 203 dpi, matching ``labcore.labelprint``.
"""

from __future__ import annotations

import base64
import html
import ipaddress
import re
from dataclasses import dataclass
from functools import lru_cache
from importlib import resources
from urllib.parse import quote

import segno

LABEL_WIDTH_DOTS = 406
LABEL_HEIGHT_DOTS = 254
MARGIN_DOTS = 14
FULL_WIDTH = LABEL_WIDTH_DOTS - 2 * MARGIN_DOTS
# A QR sits under the header rule at the left; text moves to this column.
# 140 dots is the room between the margin and the column: version 13 at
# magnification 2 (138 dots) still fits, anything larger is flagged.
QR_MAX_DOTS = 140
TEXT_COLUMN_X = 160
TEXT_COLUMN_WIDTH = LABEL_WIDTH_DOTS - MARGIN_DOTS - TEXT_COLUMN_X
LAB_NAME = "Mazin Lab"

# Advance widths (per 1000 em) of Barlow Semi Condensed Bold, the preview's
# stand-in for the printer's bold condensed font 0. Used to size one-line
# text and to wrap the preview; the printer wraps ^FB text with its own
# metrics, so preview and print may differ by a word at a wrap boundary.
_WIDTHS = {
    " ": 200, "!": 311, '"': 352, "#": 651, "$": 508, "%": 795, "&": 654,
    "'": 169, "(": 329, ")": 329, "*": 380, "+": 462, ",": 238, "-": 370,
    ".": 247, "/": 444, "0": 511, "1": 319, "2": 499, "3": 487, "4": 544,
    "5": 488, "6": 488, "7": 451, "8": 490, "9": 482, ":": 319, ";": 274,
    "<": 462, "=": 462, ">": 462, "?": 479, "@": 786, "A": 577, "B": 545,
    "C": 536, "D": 547, "E": 511, "F": 490, "G": 540, "H": 554, "I": 246,
    "J": 518, "K": 558, "L": 499, "M": 631, "N": 590, "O": 547, "P": 531,
    "Q": 527, "R": 543, "S": 520, "T": 526, "U": 554, "V": 555, "W": 783,
    "X": 553, "Y": 546, "Z": 485, "[": 381, "\\": 444, "]": 381, "^": 448,
    "_": 472, "`": 226, "a": 487, "b": 505, "c": 486, "d": 505, "e": 492,
    "f": 342, "g": 498, "h": 497, "i": 237, "j": 235, "k": 491, "l": 227,
    "m": 755, "n": 497, "o": 503, "p": 508, "q": 508, "r": 354, "s": 457,
    "t": 335, "u": 496, "v": 478, "w": 698, "x": 488, "y": 464, "z": 416,
    "{": 360, "|": 194, "}": 360, "~": 512,
}
_DEFAULT_WIDTH = 560


@dataclass(frozen=True)
class TextBox:
    x: int
    y: int
    width: int
    font_dots: int
    text: str
    lines: int = 1
    spacing: int = 0
    align: str = "L"  # L or R, as ^FB justification letters


@dataclass(frozen=True)
class Rule:
    x: int
    y: int
    width: int
    thickness: int = 2


@dataclass(frozen=True)
class QR:
    x: int
    y: int
    data: str
    magnification: int
    matrix: tuple[tuple[int, ...], ...]


@dataclass(frozen=True)
class Bitmap:
    """A 1-bit image: ``rows`` packed MSB-first, each row padded to whole
    bytes (the ^GFA layout), and the same pixels as PNG for the preview."""

    x: int
    y: int
    width: int
    height: int
    rows: bytes
    png: bytes

    @property
    def row_bytes(self) -> int:
        return (self.width + 7) // 8


Element = TextBox | Rule | QR | Bitmap
Label = list[Element]

MARK_SIZE_DOTS = 132
SMALL_MARK_SIZE_DOTS = 88


@lru_cache(maxsize=4)
def _mark_assets(size: int) -> tuple[int, int, bytes, bytes]:
    assets = resources.files("labcore") / "assets"
    pbm = (assets / f"mazin_lab_mark_{size}.pbm").read_bytes()
    png = (assets / f"mazin_lab_mark_{size}.png").read_bytes()
    # P4 header: magic, whitespace, width, whitespace, height, one whitespace.
    header, _, dims, _, data = re.match(rb"(P4)(\s+)(\d+\s+\d+)(\s)(.*)", pbm, re.S).groups()
    width, height = (int(v) for v in dims.split())
    return width, height, data, png


def lab_mark(x: int, y: int, size: int = MARK_SIZE_DOTS) -> Bitmap:
    """The lab's badge, pre-rendered (see scripts/make_label_mark.py)."""
    width, height, rows, png = _mark_assets(size)
    return Bitmap(x, y, width, height, rows, png)


# Where a badge can go. "left"/"right" are the full-size column slots under
# the header rule; the corner slots take the small badge so a QR code (left
# column) and the body text keep their room.
RIGHT_COLUMN_X = LABEL_WIDTH_DOTS - MARGIN_DOTS - MARK_SIZE_DOTS  # 260
RIGHT_COLUMN_TEXT_END = RIGHT_COLUMN_X - 14  # 246
CORNER_X = LABEL_WIDTH_DOTS - MARGIN_DOTS - SMALL_MARK_SIZE_DOTS  # 304
CORNER_TEXT_END = CORNER_X - 14  # 290
# Label-top registration wanders by a few dots and the die-cut corners are
# rounded, so a badge hard against the leading edge loses its top.
CORNER_TOP_Y = 16
COMPUTER_LOGO_POSITIONS = ("left", "right")
GENERAL_LOGO_POSITIONS = ("left", "right", "top_right", "bottom_right")


def _check_position(position: str, allowed: tuple[str, ...]) -> None:
    if position not in allowed:
        raise ValueError(f"logo position must be one of {', '.join(allowed)}")


def estimate_width(text: str, font_dots: int) -> float:
    return sum(_WIDTHS.get(char, _DEFAULT_WIDTH) for char in text) * font_dots / 1000


def fit_font(text: str, width: int, max_dots: int, min_dots: int) -> int:
    """Largest font height in [min, max] whose estimated width fits."""
    for size in range(max_dots, min_dots, -1):
        if estimate_width(text, size) <= width:
            return size
    return min_dots


def _hard_break(token: str, width: int, font_dots: int) -> list[str]:
    pieces: list[str] = []
    current = ""
    for char in token:
        if current and estimate_width(current + char, font_dots) > width:
            pieces.append(current)
            current = char
        else:
            current += char
    if current:
        pieces.append(current)
    return pieces


def wrap_lines(
    text: str, width: int, font_dots: int, max_lines: int
) -> tuple[list[str], bool]:
    """Greedy word wrap; returns the visible lines and whether any were cut."""
    lines: list[str] = []
    for paragraph in text.split("\n"):
        current = ""
        for token in paragraph.split():
            candidate = f"{current} {token}" if current else token
            if estimate_width(candidate, font_dots) <= width:
                current = candidate
                continue
            if current:
                lines.append(current)
            pieces = _hard_break(token, width, font_dots)
            lines.extend(pieces[:-1])
            current = pieces[-1] if pieces else ""
        lines.append(current)
    return lines[:max_lines], len(lines) > max_lines


def make_qr(data: str, x: int, y: int, max_dots: int = QR_MAX_DOTS) -> QR:
    """QR sized so the symbol never exceeds ``max_dots`` on the label.

    Error level M with no boost matches the printer's ``^FDMA,`` encoding,
    so the module count here is the module count the printer will draw.
    """
    # The QR field prints under a single byte code page (see to_zpl), so
    # anything outside ASCII is percent-encoded: URLs stay valid and the
    # preview encodes exactly the bytes the printer will.
    data = "".join(char if ord(char) < 128 else quote(char) for char in data)
    code = segno.make(data, error="m", boost_error=False, micro=False)
    matrix = tuple(tuple(int(bit) for bit in row) for row in code.matrix)
    magnification = max(2, min(4, max_dots // len(matrix)))
    return QR(x, y, data, magnification, matrix)


_MAC_RE = re.compile(r"^[0-9A-F]{12}$")


def normalize_mac(raw: str) -> str | None:
    hex_digits = re.sub(r"[\s:\-.]", "", raw).upper()
    if not _MAC_RE.match(hex_digits):
        return None
    return ":".join(hex_digits[i : i + 2] for i in range(0, 12, 2))


def _ip_problem(raw: str) -> str | None:
    if not raw:
        return None
    try:
        ipaddress.ip_address(raw)
    except ValueError:
        return f"IP address {raw!r} is not a valid IPv4 or IPv6 address"
    return None


def computer_label(
    hostname: str,
    mac: str,
    ip: str,
    date: str,
    logo: bool = False,
    logo_position: str = "left",
) -> tuple[Label, list[str]]:
    if logo:
        _check_position(logo_position, COMPUTER_LOGO_POSITIONS)
    problems: list[str] = []
    hostname = hostname.strip()
    mac = mac.strip()
    ip = ip.strip()
    if not hostname:
        problems.append("Hostname is empty")
    normalized_mac = normalize_mac(mac) if mac else ""
    if mac and normalized_mac is None:
        problems.append(f"MAC address {mac!r} is not 12 hex digits")
        normalized_mac = mac
    if ip_problem := _ip_problem(ip):
        problems.append(ip_problem)

    host_size = fit_font(hostname, FULL_WIDTH, 60, 28)
    if estimate_width(hostname, host_size) > FULL_WIDTH:
        problems.append("Hostname is too long to fit even at the smallest size")
    label: Label = [
        TextBox(MARGIN_DOTS, 20, FULL_WIDTH, host_size, hostname),
        Rule(MARGIN_DOTS, 88, FULL_WIDTH),
    ]
    rows = ((normalized_mac or "", "MAC"), (ip, "IP"))
    if logo:
        # The badge takes one column below the rule (clear of the hostname's
        # descenders); captions stack over their values in the other column,
        # and the badge replaces the text mark.
        if logo_position == "left":
            label.append(lab_mark(MARGIN_DOTS, 100))
            text_x, text_width = TEXT_COLUMN_X, TEXT_COLUMN_WIDTH
        else:
            label.append(lab_mark(RIGHT_COLUMN_X, 100))
            text_x, text_width = MARGIN_DOTS, RIGHT_COLUMN_TEXT_END - MARGIN_DOTS
        for index, (value, caption) in enumerate(rows):
            top = 100 + index * 58
            label.append(TextBox(text_x, top, text_width, 16, caption))
            value_size = fit_font(value, text_width, 28, 16)
            label.append(TextBox(text_x, top + 18, text_width, value_size, value))
        date_align = "R" if logo_position == "left" else "L"
        label.append(TextBox(text_x, 224, text_width, 18, date, align=date_align))
        return label, problems

    value_x = MARGIN_DOTS + 60
    value_width = LABEL_WIDTH_DOTS - MARGIN_DOTS - value_x
    for index, (value, caption) in enumerate(rows):
        row_y = 104 + index * 46
        value_size = fit_font(value, value_width, 30, 18)
        label.append(TextBox(MARGIN_DOTS, row_y + 12, 60, 18, caption))
        label.append(TextBox(value_x, row_y, value_width, value_size, value))
    label.append(TextBox(MARGIN_DOTS, 224, FULL_WIDTH, 18, date))
    label.append(TextBox(MARGIN_DOTS, 224, FULL_WIDTH, 18, LAB_NAME, align="R"))
    return label, problems


BODY_FONT_DOTS = 22
BODY_MAX_LINES = 4


def general_label(
    title: str,
    body: str,
    url: str,
    date: str,
    logo: bool = False,
    logo_position: str = "left",
) -> tuple[Label, list[str]]:
    if logo:
        _check_position(logo_position, GENERAL_LOGO_POSITIONS)
    problems: list[str] = []
    title = title.strip()
    body = body.strip()
    url = url.strip()
    if not title and not body:
        problems.append("Label is empty")

    # The header row loses its right end to a top-right badge.
    header_width = CORNER_TEXT_END - MARGIN_DOTS if logo and logo_position == "top_right" else FULL_WIDTH
    title_size = fit_font(title, header_width, 40, 24)
    if estimate_width(title, title_size) > header_width:
        problems.append("Title is too long to fit even at the smallest size")
    label: Label = [
        TextBox(MARGIN_DOTS, 22, header_width, title_size, title),
        Rule(MARGIN_DOTS, 70, header_width),
    ]

    # The body column runs between whatever occupies the two column slots.
    text_start, text_end = MARGIN_DOTS, LABEL_WIDTH_DOTS - MARGIN_DOTS
    if url:
        qr = make_qr(url, MARGIN_DOTS, 80)
        if len(qr.matrix) * qr.magnification > QR_MAX_DOTS:
            problems.append("URL is very long; the QR code may overflow and not scan")
        label.append(qr)
        text_start = TEXT_COLUMN_X
        if logo and logo_position == "left":
            problems.append(
                "Logo and QR code both want the left column; the QR code was kept. "
                "Choose another logo position to have both."
            )
            logo = False
    if logo:
        match logo_position:
            case "left":
                label.append(lab_mark(MARGIN_DOTS, 80))
                text_start = TEXT_COLUMN_X
            case "right":
                label.append(lab_mark(RIGHT_COLUMN_X, 80))
                text_end = RIGHT_COLUMN_TEXT_END
                if url:
                    problems.append("Body column is narrow with a QR code and a right-column logo")
            case "top_right":
                label.append(lab_mark(CORNER_X, CORNER_TOP_Y, SMALL_MARK_SIZE_DOTS))
            case "bottom_right":
                label.append(lab_mark(CORNER_X, 158, SMALL_MARK_SIZE_DOTS))
    text_width = text_end - text_start
    # Three body rows end at 154, just above a bottom-right badge at 158; a
    # top-right badge ends at 104, so the body starts under it instead and
    # its four rows still end above the date at 220.
    max_lines = 3 if logo and logo_position == "bottom_right" else BODY_MAX_LINES
    body_y = CORNER_TOP_Y + SMALL_MARK_SIZE_DOTS + 6 if logo and logo_position == "top_right" else 80

    _, truncated = wrap_lines(body, text_width, BODY_FONT_DOTS, max_lines)
    if truncated:
        problems.append(f"Body is longer than {max_lines} lines and will be cut")
    label.append(TextBox(text_start, body_y, text_width, BODY_FONT_DOTS, body, max_lines, 4))
    if logo and logo_position == "bottom_right":
        label.append(TextBox(MARGIN_DOTS, 224, TEXT_COLUMN_WIDTH, 18, date))
    elif logo:
        label.append(TextBox(text_start, 220, text_width, 18, date, align="R"))
    else:
        label.append(TextBox(text_start, 196, text_width, 18, date, align="R"))
        label.append(TextBox(text_start, 220, text_width, 18, LAB_NAME, align="R"))
    return label, problems


_ZPL_HEX_ESCAPES = {"_": "_5F", "^": "_5E", "~": "_7E", "\\": "_5C"}


def _zpl_field(text: str, keep_newlines: bool = False) -> str:
    """Return ``[^FH]^FD<data>`` with ZPL control characters made literal.

    ^ and ~ start ZPL commands and \\ starts ^FB escapes, so user text must
    never reach the printer raw. Blanking them corrupts data (a QR for
    ``.../~bmazin/`` used to encode a space), so instead switch the field to
    hex mode with ^FH and spell the four special bytes as ``_XX``. ^FH is
    only emitted when needed to keep the plain ZPL readable. With
    keep_newlines, a newline becomes the ^FB line break ``\\&``.
    """
    lines = text.split("\n") if keep_newlines else [text]
    escaped = ["".join(_ZPL_HEX_ESCAPES.get(char, char) for char in line) for line in lines]
    data = "\\&".join(escaped)
    prefix = "^FH" if any(char in text for char in _ZPL_HEX_ESCAPES) else ""
    return f"{prefix}^FD{data}"


def to_zpl(label: Label, copies: int = 1) -> str:
    commands = ["^XA", "^CI28", f"^PW{LABEL_WIDTH_DOTS}", f"^LL{LABEL_HEIGHT_DOTS}"]
    for element in label:
        match element:
            case TextBox():
                field = f"^FO{element.x},{element.y}^A0N,{element.font_dots},{element.font_dots}"
                if element.lines > 1 or element.align != "L":
                    field += (
                        f"^FB{element.width},{element.lines},{element.spacing},{element.align}"
                    )
                commands.append(f"{field}{_zpl_field(element.text, keep_newlines=True)}^FS")
            case Rule():
                commands.append(
                    f"^FO{element.x},{element.y}^GB{element.width},"
                    f"{element.thickness},{element.thickness}^FS"
                )
            case QR():
                # Under ^CI28 the ZD421's QR encoder silently drops "~" (0x7E
                # is an overline in the QR default charset); single byte pages
                # keep it. Verified on the printer 2026-09-04.
                commands.append("^CI0")
                commands.append(
                    f"^FO{element.x},{element.y}^BQN,2,{element.magnification}"
                    f"{_zpl_field('MA,' + element.data)}^FS"
                )
                commands.append("^CI28")
            case Bitmap():
                total = len(element.rows)
                commands.append(
                    f"^FO{element.x},{element.y}^GFA,{total},{total},"
                    f"{element.row_bytes},{element.rows.hex().upper()}^FS"
                )
    if copies > 1:
        commands.append(f"^PQ{copies}")
    commands.append("^XZ")
    return "\n".join(commands)


def to_svg(label: Label) -> str:
    parts = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {LABEL_WIDTH_DOTS} '
        f'{LABEL_HEIGHT_DOTS}" class="label-preview" role="img">',
        f'<rect width="{LABEL_WIDTH_DOTS}" height="{LABEL_HEIGHT_DOTS}" fill="#fff"/>',
    ]
    for element in label:
        match element:
            case TextBox():
                if element.lines > 1 or "\n" in element.text:
                    rows, _ = wrap_lines(
                        element.text, element.width, element.font_dots, element.lines
                    )
                else:
                    rows = [element.text]
                anchor = "end" if element.align == "R" else "start"
                x = element.x + element.width if element.align == "R" else element.x
                for index, row in enumerate(rows):
                    y = element.y + index * (element.font_dots + element.spacing)
                    parts.append(
                        f'<text x="{x}" y="{y}" font-size="{element.font_dots}" '
                        f'text-anchor="{anchor}" dominant-baseline="text-before-edge">'
                        f"{html.escape(row)}</text>"
                    )
            case Rule():
                parts.append(
                    f'<rect x="{element.x}" y="{element.y}" width="{element.width}" '
                    f'height="{element.thickness}"/>'
                )
            case QR():
                size = element.magnification
                for row_index, row in enumerate(element.matrix):
                    for col_index, bit in enumerate(row):
                        if bit:
                            parts.append(
                                f'<rect x="{element.x + col_index * size}" '
                                f'y="{element.y + row_index * size}" '
                                f'width="{size}" height="{size}"/>'
                            )
            case Bitmap():
                encoded = base64.b64encode(element.png).decode("ascii")
                parts.append(
                    f'<image x="{element.x}" y="{element.y}" width="{element.width}" '
                    f'height="{element.height}" href="data:image/png;base64,{encoded}"/>'
                )
    parts.append("</svg>")
    return "".join(parts)

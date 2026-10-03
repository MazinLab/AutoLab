from __future__ import annotations

import pytest

from labcore.labeldesign import (
    LABEL_HEIGHT_DOTS,
    LABEL_WIDTH_DOTS,
    QR,
    QR_MAX_DOTS,
    Rule,
    TextBox,
    computer_label,
    estimate_width,
    fit_font,
    general_label,
    make_qr,
    normalize_mac,
    to_svg,
    to_zpl,
    wrap_lines,
)


@pytest.mark.parametrize(
    "raw",
    ["aa:bb:cc:dd:ee:ff", "AA-BB-CC-DD-EE-FF", "aabb.ccdd.eeff", "aabbccddeeff", " aa:bb:cc:dd:ee:ff "],
)
def test_normalize_mac_accepts_common_forms(raw: str) -> None:
    assert normalize_mac(raw) == "AA:BB:CC:DD:EE:FF"


@pytest.mark.parametrize("raw", ["zz:bb:cc:dd:ee:ff", "aabbccddeef", "", "aa:bb:cc:dd:ee:ff:00"])
def test_normalize_mac_rejects_garbage(raw: str) -> None:
    assert normalize_mac(raw) is None


def test_computer_label_reports_bad_ip_but_still_renders() -> None:
    label, problems = computer_label("mec", "aa:bb:cc:dd:ee:ff", "999.1.1.1", "09/02/26")
    assert any("IP" in problem for problem in problems)
    assert any(isinstance(e, TextBox) and e.text == "999.1.1.1" for e in label)


@pytest.mark.parametrize("ip", ["192.168.254.254", "fe80::1"])
def test_computer_label_accepts_v4_and_v6(ip: str) -> None:
    _, problems = computer_label("mec", "aa:bb:cc:dd:ee:ff", ip, "09/02/26")
    assert problems == []


def test_fit_font_shrinks_only_as_needed() -> None:
    assert fit_font("mec", 378, 60, 28) == 60
    long_name = "mec-cleanroom-workstation-07"
    size = fit_font(long_name, 378, 60, 28)
    assert 28 <= size < 60
    assert estimate_width(long_name, size) <= 378
    assert fit_font("x" * 200, 378, 60, 28) == 28


def test_wrap_lines_breaks_at_spaces_and_hard_breaks_long_tokens() -> None:
    lines, truncated = wrap_lines("HfTa TM2 wafer for the MEC cooldown", 232, 22, 4)
    assert len(lines) > 1
    assert not truncated
    assert all(estimate_width(line, 22) <= 232 for line in lines)
    lines, truncated = wrap_lines("A" * 80, 232, 22, 2)
    assert truncated
    assert len(lines) == 2


def test_wrap_lines_honours_user_newlines() -> None:
    lines, _ = wrap_lines("first\nsecond", 378, 22, 4)
    assert lines == ["first", "second"]


def test_qr_magnification_shrinks_for_long_data() -> None:
    short = make_qr("https://autolab.physics.ucsb.edu/e/W-2026-0001", 14, 80)
    assert short.magnification == 4
    long = make_qr("https://example.org/" + "x" * 280, 14, 80)
    assert long.magnification < 4
    assert len(long.matrix) * long.magnification <= QR_MAX_DOTS


def test_to_zpl_hex_escapes_control_characters_and_carries_copies() -> None:
    label = [TextBox(14, 20, 378, 30, "safe^XZ~JA\\text_1")]
    zpl = to_zpl(label, copies=3)
    assert zpl.count("^XZ") == 1
    assert "~JA" not in zpl
    assert "^FH^FDsafe_5EXZ_7EJA_5Ctext_5F1^FS" in zpl
    assert "^PQ3" in zpl
    assert "^PQ" not in to_zpl(label)


def test_to_zpl_keeps_plain_fields_free_of_fh() -> None:
    label = [TextBox(14, 20, 378, 30, "Plain text")]
    assert "^FH" not in to_zpl(label)


def test_to_zpl_qr_keeps_tilde_in_url() -> None:
    url = "https://web.physics.ucsb.edu/~bmazin/"
    zpl = to_zpl([make_qr(url, 14, 80)])
    assert (
        "^CI0\n^FO14,80^BQN,2,4^FH^FDMA,https://web.physics.ucsb.edu/_7Ebmazin/^FS\n^CI28"
    ) in zpl
    assert "ucsb.edu/ bmazin" not in zpl


def test_make_qr_percent_encodes_non_ascii() -> None:
    qr = make_qr("https://example.org/caf\u00e9", 14, 80)
    assert qr.data == "https://example.org/caf%C3%A9"


def test_to_zpl_multiline_text_uses_fb_line_break() -> None:
    label = [TextBox(14, 20, 378, 22, "line one\nline ~two", lines=2)]
    zpl = to_zpl(label)
    assert "^FH^FDline one\\&line _7Etwo^FS" in zpl


def test_computer_label_golden_zpl() -> None:
    label, problems = computer_label("mec", "aa:bb:cc:dd:ee:ff", "192.168.254.1", "09/02/26")
    assert problems == []
    assert to_zpl(label) == (
        "^XA\n^CI28\n^PW406\n^LL254\n"
        "^FO14,20^A0N,60,60^FDmec^FS\n"
        "^FO14,88^GB378,2,2^FS\n"
        "^FO14,116^A0N,18,18^FDMAC^FS\n"
        "^FO74,104^A0N,30,30^FDAA:BB:CC:DD:EE:FF^FS\n"
        "^FO14,162^A0N,18,18^FDIP^FS\n"
        "^FO74,150^A0N,30,30^FD192.168.254.1^FS\n"
        "^FO14,224^A0N,18,18^FD09/02/26^FS\n"
        "^FO14,224^A0N,18,18^FB378,1,0,R^FDMazin Lab^FS\n"
        "^XZ"
    )


def test_general_label_without_url_uses_full_width() -> None:
    label, problems = general_label("Spare cables", "Do not remove\nfrom bench 3", "", "09/02/26")
    assert problems == []
    zpl = to_zpl(label)
    assert "^BQ" not in zpl
    assert "^FO14,22^A0N,40,40^FDSpare cables^FS" in zpl
    assert "^FO14,80^A0N,22,22^FB378,4,4,L^FDDo not remove\\&from bench 3^FS" in zpl
    assert "^FO14,220^A0N,18,18^FB378,1,0,R^FDMazin Lab^FS" in zpl


def test_general_label_with_url_adds_qr_and_narrows_text() -> None:
    url = "https://autolab.physics.ucsb.edu/e/W-2026-0001"
    label, _ = general_label("Wafer box", "HfTa TM2", url, "09/02/26")
    zpl = to_zpl(label)
    assert f"^CI0\n^FO14,80^BQN,2,4^FDMA,{url}^FS\n^CI28" in zpl
    assert "^FO160,80^A0N,22,22^FB232,4,4,L^FDHfTa TM2^FS" in zpl
    assert any(isinstance(e, QR) for e in label)


def test_general_label_flags_overlong_body() -> None:
    _, problems = general_label("T", "word " * 120, "", "09/02/26")
    assert any("body" in problem.lower() for problem in problems)


def test_to_svg_draws_rows_and_qr_modules() -> None:
    url = "https://autolab.physics.ucsb.edu/e/W-2026-0001"
    label, _ = general_label("Wafer box", "HfTa TM2 wafer for the MEC cooldown run", url, "09/02/26")
    svg = to_svg(label)
    assert svg.startswith("<svg")
    assert f'viewBox="0 0 {LABEL_WIDTH_DOTS} {LABEL_HEIGHT_DOTS}"' in svg
    # Wrapped body: more <text> rows than elements.
    assert svg.count("<text") > sum(isinstance(e, TextBox) for e in label)
    assert svg.count("<rect") > 100
    assert "&lt;" not in svg
    assert "<script" not in svg


def test_to_svg_escapes_markup_in_user_text() -> None:
    svg = to_svg([TextBox(14, 20, 378, 30, "<script>alert(1)</script>")])
    assert "<script" not in svg
    assert "&lt;script&gt;" in svg


def test_layout_stays_inside_the_label() -> None:
    label, _ = general_label("Title", "body " * 40, "https://example.org/" + "x" * 280, "09/02/26")
    for element in label:
        if isinstance(element, QR):
            assert element.y + len(element.matrix) * element.magnification <= LABEL_HEIGHT_DOTS
        if isinstance(element, TextBox):
            assert element.x + element.width <= LABEL_WIDTH_DOTS
            assert element.y + element.font_dots <= LABEL_HEIGHT_DOTS
        if isinstance(element, Rule):
            assert element.x + element.width <= LABEL_WIDTH_DOTS


# ---------------------------------------------------------------------------
# Optional lab mark

from labcore.labeldesign import Bitmap, lab_mark  # noqa: E402


def _marks(label: list) -> list[Bitmap]:
    return [e for e in label if isinstance(e, Bitmap)]


def _text(label: list, value: str) -> TextBox:
    return next(e for e in label if isinstance(e, TextBox) and e.text == value)


@pytest.mark.parametrize("size", [132, 88])
def test_lab_mark_is_a_square_bitmap_at_both_sizes(size: int) -> None:
    mark = lab_mark(14, 80, size)
    assert (mark.width, mark.height) == (size, size)
    assert len(mark.rows) == size * ((size + 7) // 8)
    assert mark.png.startswith(b"\x89PNG")


def test_to_zpl_emits_a_gfa_graphic_for_bitmaps() -> None:
    zpl = to_zpl([lab_mark(14, 80)])
    assert "^FO14,80^GFA,2244,2244,17," in zpl
    hex_part = zpl.split("^GFA,2244,2244,17,")[1].split("^FS")[0]
    assert len(hex_part) == 2244 * 2
    assert set(hex_part) <= set("0123456789ABCDEF")


def test_to_svg_embeds_bitmap_as_png_image() -> None:
    svg = to_svg([lab_mark(14, 80)])
    assert '<image x="14" y="80" width="132" height="132" href="data:image/png;base64,' in svg


def test_computer_logo_left_sits_below_the_rule_and_rows_move_right() -> None:
    label, problems = computer_label("mec", "aa:bb:cc:dd:ee:ff", "192.168.254.1", "09/02/26", logo=True)
    assert problems == []
    (mark,) = _marks(label)
    rule = next(e for e in label if isinstance(e, Rule))
    assert (mark.x, mark.y) == (14, 100)
    assert mark.y >= rule.y + rule.thickness + 8
    assert mark.y + mark.height <= LABEL_HEIGHT_DOTS - 14
    assert not any(isinstance(e, TextBox) and e.text == "Mazin Lab" for e in label)
    for value in ("AA:BB:CC:DD:EE:FF", "192.168.254.1"):
        box = _text(label, value)
        assert box.x == 160 and box.x + box.width <= LABEL_WIDTH_DOTS - 14


def test_computer_logo_right_keeps_rows_left() -> None:
    label, _ = computer_label("mec", "aa:bb:cc:dd:ee:ff", "10.0.0.1", "09/02/26", logo=True, logo_position="right")
    (mark,) = _marks(label)
    assert (mark.x, mark.y) == (260, 100)
    assert _text(label, "AA:BB:CC:DD:EE:FF").x == 14
    assert _text(label, "10.0.0.1").x + _text(label, "10.0.0.1").width <= 246
    assert _text(label, "09/02/26").x == 14


def test_computer_rejects_corner_positions() -> None:
    with pytest.raises(ValueError, match="logo position"):
        computer_label("mec", "", "", "09/02/26", logo=True, logo_position="top_right")


def test_general_logo_left_uses_left_slot_when_no_url() -> None:
    label, problems = general_label("Box", "stuff", "", "09/02/26", logo=True)
    assert problems == []
    (mark,) = _marks(label)
    assert (mark.x, mark.y, mark.width) == (14, 80, 132)
    assert not any(isinstance(e, QR) for e in label)
    assert not any(isinstance(e, TextBox) and e.text == "Mazin Lab" for e in label)
    assert _text(label, "stuff").x == 160


def test_general_logo_left_with_url_keeps_qr_and_says_so() -> None:
    label, problems = general_label("Box", "stuff", "https://example.org", "09/02/26", logo=True)
    assert any(isinstance(e, QR) for e in label)
    assert _marks(label) == []
    assert any("logo" in problem.lower() for problem in problems)


def test_general_logo_right_narrows_body_from_the_right() -> None:
    label, problems = general_label("Box", "stuff", "", "09/02/26", logo=True, logo_position="right")
    assert problems == []
    (mark,) = _marks(label)
    assert (mark.x, mark.y, mark.width) == (260, 80, 132)
    body = _text(label, "stuff")
    assert body.x == 14 and body.x + body.width <= 246


def test_general_logo_right_with_url_squeezes_body_between_and_warns() -> None:
    label, problems = general_label("Box", "stuff", "https://example.org", "09/02/26", logo=True, logo_position="right")
    assert any(isinstance(e, QR) for e in label)
    (mark,) = _marks(label)
    assert mark.x == 260
    body = _text(label, "stuff")
    assert body.x == 160 and body.x + body.width <= 246
    assert any("narrow" in problem.lower() for problem in problems)


def test_general_logo_top_right_shortens_title_and_rule() -> None:
    label, problems = general_label("Box", "stuff", "https://example.org", "09/02/26", logo=True, logo_position="top_right")
    assert problems == []
    (mark,) = _marks(label)
    assert (mark.x, mark.y, mark.width) == (304, 16, 88)
    assert mark.y >= 16  # off the leading edge, like the header text
    title = _text(label, "Box")
    rule = next(e for e in label if isinstance(e, Rule))
    assert title.x + title.width <= 290 and rule.x + rule.width <= 290
    assert any(isinstance(e, QR) for e in label)
    body = _text(label, "stuff")
    assert body.x == 160
    # The body clears the badge's lower edge and still ends above the date.
    assert body.y >= mark.y + mark.height
    assert body.y + body.lines * (body.font_dots + body.spacing) - body.spacing <= 220


def test_general_logo_bottom_right_fits_beside_qr_and_moves_date_left() -> None:
    label, problems = general_label("Box", "one two three", "https://example.org", "09/02/26", logo=True, logo_position="bottom_right")
    assert problems == []
    (mark,) = _marks(label)
    assert (mark.x, mark.y, mark.width) == (304, 158, 88)
    assert mark.y + mark.height <= LABEL_HEIGHT_DOTS
    body = _text(label, "one two three")
    assert body.x == 160 and body.lines == 3
    assert body.y + body.lines * (body.font_dots + body.spacing) - body.spacing <= mark.y
    date = _text(label, "09/02/26")
    assert date.x == 14 and date.align == "L"


def test_general_rejects_unknown_position() -> None:
    with pytest.raises(ValueError, match="logo position"):
        general_label("Box", "", "", "09/02/26", logo=True, logo_position="middle")

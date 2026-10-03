import pytest

from labcore.labelprint import render_zpl


def test_qr_label_matches_golden_zpl() -> None:
    assert render_zpl(
        accession="W-2026-0001",
        qr_url="https://autolab.example/e/W-2026-0001",
        human_line="W 2026-03-12 · M8 mask · Al on Si",
        created_date="08/13/26",
    ) == (
        "^XA\n"
        "^CI28\n"
        "^PW406\n"
        "^LL254\n"
        "^FO14,24^A0N,38,38^FDW-2026-0001^FS\n"
        "^FO14,70^GB378,2,2^FS\n"
        "^FO14,80^BQN,2,4^FDMA,https://autolab.example/e/W-2026-0001^FS\n"
        "^FO160,82^A0N,24,24^FB232,3,4,L"
        "^FDW 2026-03-12 · M8 mask · Al on Si^FS\n"
        "^FO160,190^A0N,20,20^FB232,1,0,R^FD08/13/26^FS\n"
        "^FO160,216^A0N,20,20^FB232,1,0,R^FDMazin Lab^FS\n"
        "^XZ"
    )


def test_text_label_matches_golden_zpl_without_qr() -> None:
    zpl = render_zpl(
        accession="DEV-2026-0417",
        qr_url="https://autolab.example/e/DEV-2026-0417",
        human_line="device 7",
        label_format="text",
        created_date="08/13/26",
    )

    assert zpl == (
        "^XA\n"
        "^CI28\n"
        "^PW406\n"
        "^LL254\n"
        "^FO14,24^A0N,46,46^FDDEV-2026-0417^FS\n"
        "^FO14,78^GB378,2,2^FS\n"
        "^FO14,88^A0N,30,30^FB378,2,6,L^FDdevice 7^FS\n"
        "^FO14,190^A0N,20,20^FB378,1,0,R^FD08/13/26^FS\n"
        "^FO14,216^A0N,20,20^FB378,1,0,R^FDMazin Lab^FS\n"
        "^XZ"
    )
    assert "^BQ" not in zpl


def test_long_human_line_wraps_instead_of_running_off_the_label() -> None:
    """The old layout clipped long names (and the accession with them)."""
    zpl = render_zpl(
        accession="SUB-2026-0001",
        qr_url="https://autolab.example/e/SUB-2026-0001",
        human_line="DSP Sapphire Lot 772511 case 1/2",
    )

    # ^FB hands wrapping to the printer, bounded by the text column width.
    assert "^FB232,3,4,L^FDDSP Sapphire Lot 772511 case 1/2^FS" in zpl
    # The accession stays on its own full-width line, untruncated.
    assert "^FO14,24^A0N,38,38^FDSUB-2026-0001^FS" in zpl


def test_every_label_carries_the_lab_name() -> None:
    """A wafer box found loose in the cleanroom should say whose it is."""
    for label_format in ("qr", "text"):
        zpl = render_zpl(
            accession="W-2026-0001",
            qr_url="https://autolab.example/e/W-2026-0001",
            human_line="260813a HfTa TM2",
            label_format=label_format,
        )
        assert "^FDMazin Lab^FS" in zpl
        # Clear of the header: the longest accessions would collide there.
        assert ",28^A0N,20,20" not in zpl


def test_creation_date_prints_above_the_lab_mark() -> None:
    from labcore.labelprint import DATE_Y_DOTS, LAB_NAME_Y_DOTS

    zpl = render_zpl(
        accession="W-2026-0001",
        qr_url="https://autolab.example/e/W-2026-0001",
        human_line="260813a HfTa TM2",
        created_date="08/13/26",
    )

    assert "^FD08/13/26^FS" in zpl
    assert DATE_Y_DOTS < LAB_NAME_Y_DOTS
    # The wrapped name must not grow down into the date.
    from labcore.labelprint import BODY_TOP_DOTS, HUMAN_LINE_MAX_LINES

    assert BODY_TOP_DOTS + 2 + HUMAN_LINE_MAX_LINES * 28 <= DATE_Y_DOTS


def test_layout_stays_within_the_label_bounds() -> None:
    from labcore.labelprint import (
        BODY_TOP_DOTS,
        HEADER_TOP_DOTS,
        LABEL_HEIGHT_DOTS,
        LABEL_WIDTH_DOTS,
        MARGIN_DOTS,
        QR_SIZE_DOTS,
        TEXT_COLUMN_WIDTH,
        TEXT_COLUMN_X,
    )

    assert TEXT_COLUMN_X + TEXT_COLUMN_WIDTH == LABEL_WIDTH_DOTS - MARGIN_DOTS
    # Rounded die-cut corners and a few dots of registration slop: the header
    # must not sit hard against the leading edge.
    assert HEADER_TOP_DOTS >= 20
    # The unprinted label below the QR is its quiet zone.
    assert LABEL_HEIGHT_DOTS - (BODY_TOP_DOTS + QR_SIZE_DOTS) >= 4 * 4


def test_human_line_neutralizes_zpl_control_characters() -> None:
    zpl = render_zpl(
        accession="W-2026-0001",
        qr_url="https://autolab.example/e/W-2026-0001",
        human_line="safe^XZ~JAtext",
    )

    assert "^FDsafe XZ JAtext^FS" in zpl
    assert zpl.count("^XZ") == 1
    assert "~JA" not in zpl


def test_unknown_label_format_raises() -> None:
    with pytest.raises(ValueError, match="Unknown label format: huge"):
        render_zpl(
            accession="X-1",
            qr_url="https://autolab.example/e/X-1",
            human_line="example",
            label_format="huge",
        )

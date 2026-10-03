"""Setup designer layouts: validation, evaluation, defaults."""

from __future__ import annotations

import copy

import pytest

from labcore.rfchain import (
    default_layout,
    evaluate_layout,
    load_library,
    set_coldest_stage_temp,
    validate_layout,
)

# The spec's example document (2026-09-09-setup-designer-design.md), with
# the HEMT left unbound so library values apply.
EXAMPLE = {
    "version": 1,
    "frequency_ghz": 6.0,
    "stages": [
        {"id": "rt", "label": "300 K", "temp_k": 300},
        {"id": "4k", "label": "4 K", "temp_k": 4},
        {"id": "still", "label": "Still", "temp_k": 0.8},
        {"id": "mxc", "label": "20 mK", "temp_k": 0.02},
    ],
    "chains": [
        {
            "id": "in1", "label": "Input 1", "direction": "input", "feedline": "A",
            "parts": [
                {"id": "p1", "type": "attenuator_20db", "stage": "4k"},
                {"id": "p2", "type": "attenuator_20db", "stage": "still"},
                {"id": "p3", "type": "attenuator_20db", "stage": "mxc"},
            ],
        },
        {
            "id": "out1", "label": "Output 1", "direction": "output", "feedline": "A",
            "parts": [
                {"id": "p4", "type": "isolator", "stage": "mxc"},
                {"id": "p5", "type": "coax_nbti", "stage": "still"},
                {"id": "p6", "type": "hemt", "stage": "4k"},
            ],
        },
        {
            "id": "in2", "label": "Input 2", "direction": "input",
            "parts": [
                {"id": "p7", "type": "attenuator_20db", "stage": "4k"},
                {
                    "id": "sw1", "type": "switch_6way", "stage": "4k",
                    "selected_port": 3, "ports": {"3": "in2-3", "4": "in2-4"},
                },
            ],
        },
        {
            "id": "in2-3", "label": "Port 3", "direction": "input", "feedline": "B",
            "parts": [{"id": "p8", "type": "attenuator_20db", "stage": "mxc"}],
        },
        {"id": "in2-4", "label": "Port 4", "direction": "input", "feedline": "C", "parts": []},
    ],
    "optical": [
        {"id": "o1", "type": "fiber_smf", "stage": "mxc"},
        {"id": "o2", "type": "window_quartz", "stage": "4k"},
    ],
    "notes": "",
}


def example() -> dict:
    return copy.deepcopy(EXAMPLE)


def test_example_document_is_valid() -> None:
    assert validate_layout(example()) == []


@pytest.mark.parametrize(
    ("mutate", "fragment"),
    [
        (lambda d: d["chains"][0]["parts"][0].update(type="warp_core"), "unknown type"),
        (lambda d: d["chains"][0]["parts"][0].update(stage="nowhere"), "unknown stage"),
        (lambda d: d["chains"][0]["parts"][1].update(id="p1"), "duplicate part id"),
        (lambda d: d["chains"][1].update(id="in1"), "duplicate chain id"),
        (lambda d: d["chains"][3].update(feedline="A"), "on two input chains"),
        (lambda d: d["chains"][2]["parts"][1]["ports"].update({"4": "in2-3"}), "more than one switch port"),
        (lambda d: d["chains"][2]["parts"][1]["ports"].update({"9": "in2-4"}), "outside 1..6"),
        (lambda d: d["chains"][2]["parts"][1]["ports"].update({"4": "ghost"}), "missing chain"),
        (lambda d: d["chains"][2]["parts"][1]["ports"].update({"4": "in2"}), "switch cycle"),
        (lambda d: d["chains"][2]["parts"].reverse(), "device facing part"),
        (lambda d: d["chains"][3].update(direction="output"), "same direction"),
        (lambda d: d["chains"][3]["parts"][0].update(stage="rt"), "warmer stage than switch"),
        (lambda d: d["chains"][0]["parts"][2].update(stage="4k"), "breaks stage order"),
        (lambda d: d["chains"][0]["parts"].append({"id": "amp", "type": "hemt", "stage": "mxc"}), "not allowed on an input"),
        (lambda d: d["chains"][0]["parts"][0].update(instrument_id="abc"), "cannot bind"),
        (lambda d: d["stages"][1].update(temp_k=400), "colder than the stage before"),
        (lambda d: d["chains"][0].pop("feedline"), "needs a feedline"),
        (lambda d: d["chains"][2].update(feedline="Z"), "ends in a switch"),
        (lambda d: d["chains"][2]["parts"][1].update(selected_port=5), "not a wired port"),
        (lambda d: d["optical"][0].update(type="isolator"), "non-optical type"),
    ],
)
def test_validation_rejects(mutate, fragment: str) -> None:
    layout = example()
    mutate(layout)
    messages = validate_layout(layout)
    assert any(fragment in message for message in messages), messages


def test_reversed_output_order_is_rejected_not_silently_reevaluated() -> None:
    layout = example()
    layout["chains"][1]["parts"].reverse()
    assert validate_layout(layout)


def test_example_evaluation_matches_reference_values() -> None:
    result = evaluate_layout(example())
    assert result["convention"] == "classical"
    assert result["library_version"] == load_library()["version"]
    a = result["feedlines"]["A"]
    assert a["input"]["active"] and a["input"]["attenuation_db"] == 60
    assert a["input"]["noise_temp_at_device_k"] == pytest.approx(0.028416, rel=1e-4)
    assert a["output"]["gain_db"] == pytest.approx(37.5)
    assert a["output"]["added_noise_k"] == pytest.approx(2.2859, rel=1e-4)
    assert a["output"]["added_noise_k"] != pytest.approx(2.000006, rel=1e-4)
    hemt = a["output"]["parts"][2]
    assert hemt["source"] == "library" and hemt["gain_ahead_db"] == pytest.approx(-0.5)
    b = result["feedlines"]["B"]["input"]
    assert b["active"] and b["chain_path"] == ["in2", "in2-3"]
    assert b["attenuation_db"] == pytest.approx(40.5)
    c = result["feedlines"]["C"]["input"]
    assert c == {"active": False, "chain_path": ["in2", "in2-4"]}
    messages = [w["message"] for w in result["warnings"]]
    assert any("not bound" in m for m in messages)
    assert result["feedlines"]["B"]["output"] is None


def test_unselected_switch_inactivates_branches_with_warning() -> None:
    layout = example()
    layout["chains"][2]["parts"][1]["selected_port"] = None
    result = evaluate_layout(layout)
    assert result["feedlines"]["B"]["input"]["active"] is False
    assert any("no selected port" in w["message"] for w in result["warnings"])


def test_bound_instrument_values_override_library() -> None:
    layout = example()
    layout["chains"][1]["parts"][2]["instrument_id"] = "11111111-1111-7111-8111-111111111111"
    instruments = {
        "11111111-1111-7111-8111-111111111111": {
            "gain_db": 40, "noise_temp_k": 1.0, "name": "LNF 3", "accession": "INST-1",
        }
    }
    result = evaluate_layout(layout, instruments=instruments)
    hemt = result["feedlines"]["A"]["output"]["parts"][2]
    assert hemt["source"] == "instrument" and hemt["gain_db"] == 40 and hemt["noise_k"] == 1.0
    assert result["feedlines"]["A"]["output"]["gain_db"] == pytest.approx(39.5)
    missing = evaluate_layout(layout, instruments={})
    assert missing["feedlines"]["A"]["output"]["parts"][2]["source"] == "missing_instrument"
    assert any("no longer exists" in w["message"] for w in missing["warnings"])


def test_output_side_through_a_switch_orders_parts_device_outward() -> None:
    layout = example()
    layout["chains"] += [
        {
            "id": "out2", "label": "Output 2", "direction": "output",
            "parts": [
                {"id": "osw", "type": "switch_6way", "stage": "4k", "selected_port": 1,
                 "ports": {"1": "out2-1"}},
                {"id": "oh", "type": "hemt", "stage": "4k"},
            ],
        },
        {
            "id": "out2-1", "label": "Port 1", "direction": "output", "feedline": "B",
            "parts": [{"id": "oi", "type": "isolator", "stage": "mxc"}],
        },
    ]
    assert validate_layout(layout) == []
    out = evaluate_layout(layout)["feedlines"]["B"]["output"]
    assert [p["id"] for p in out["parts"]] == ["oi", "osw", "oh"]
    assert out["chain_path"] == ["out2", "out2-1"]
    assert out["gain_db"] == pytest.approx(37.2)


@pytest.mark.parametrize(
    ("kind", "stage_count", "chain_ids"),
    [
        ("dilution_refrigerator", 5, ["in1", "out1"]),
        ("adr", 5, ["in1", "out1"]),
        ("lhe_dewar", 4, ["in1", "out1"]),
        ("probe_station", 1, ["in1", "out1"]),
        ("other", 1, ["in1", "out1"]),
        ("optical_breadboard", 1, []),
    ],
)
def test_defaults_by_kind_are_valid(kind: str, stage_count: int, chain_ids: list[str]) -> None:
    layout = default_layout(kind, 0.013)
    assert validate_layout(layout) == []
    assert len(layout["stages"]) == stage_count
    assert [c["id"] for c in layout["chains"]] == chain_ids
    if kind in ("dilution_refrigerator", "adr", "lhe_dewar"):
        ids = [s["id"] for s in layout["stages"]]
        expected = {
            "dilution_refrigerator": ["rt", "50k", "4k", "still", "mxc"],
            "adr": ["rt", "50k", "4k", "adr1", "mxc"],
            "lhe_dewar": ["rt", "50k", "4k", "mxc"],
        }[kind]
        assert ids == expected
        assert layout["stages"][-1] == {"id": "mxc", "label": "13 mK", "temp_k": 0.013}
        assert layout["notes"] == ""
    if kind == "adr":
        assert layout["stages"][3] == {"id": "adr1", "label": "800 mK", "temp_k": 0.8}
    if kind == "probe_station":
        assert all(c["parts"] == [] for c in layout["chains"])


@pytest.mark.parametrize(
    ("raw", "kind"),
    [
        ("Dilution Refrigerator", "dilution_refrigerator"),
        ("Dilution refriderator", "dilution_refrigerator"),
        ("ADR", "adr"),
        ("LHe dewar", "lhe_dewar"),
        ("optical_breadboard", "optical_breadboard"),
        ("", None),
    ],
)
def test_free_text_kinds_normalize(raw: str, kind: str | None) -> None:
    from labcore.rfchain import normalize_kind

    assert normalize_kind(raw) == kind
    if kind == "dilution_refrigerator":
        assert len(default_layout(raw, 0.008)["stages"]) == 5


def test_single_stage_layout_keeps_its_room_temperature() -> None:
    layout = set_coldest_stage_temp(default_layout("probe_station", None), 0.06)
    assert layout["stages"] == [{"id": "rt", "label": "300 K", "temp_k": 300}]


def test_default_without_base_temperature_notes_the_assumption() -> None:
    layout = default_layout("adr", None)
    assert layout["stages"][-1]["temp_k"] == 0.02
    assert "assumed 20 mK" in layout["notes"]


def test_set_coldest_stage_temp_rewrites_label() -> None:
    layout = set_coldest_stage_temp(example(), 0.06)
    assert layout["stages"][-1] == {"id": "mxc", "label": "60 mK", "temp_k": 0.06}


def test_missing_bound_device_is_reported() -> None:
    layout = example()
    layout["feedlines"] = {"A": {"device_id": "22222222-2222-7222-8222-222222222222"}}
    assert validate_layout(layout) == []
    result = evaluate_layout(layout)
    assert result["feedlines"]["A"]["device"] == {"id": "22222222-2222-7222-8222-222222222222", "missing": True}
    assert any("bound device" in w["message"] for w in result["warnings"])
    assert result["feedlines"]["B"]["device"] is None
    layout["feedlines"] = {"A": "not-an-object"}
    assert validate_layout(layout)


def test_through_binding_is_a_named_pseudo_device() -> None:
    layout = example()
    layout["feedlines"] = {"A": {"device_id": "through"}}
    assert validate_layout(layout) == []
    result = evaluate_layout(layout)
    assert result["feedlines"]["A"]["device"] == {"id": "through", "name": "Through", "through": True}
    assert not any("bound device" in w["message"] for w in result["warnings"])


def test_fiber_may_target_a_feedline_that_exists() -> None:
    layout = example()
    layout["optical"][0]["feedline"] = "A"
    assert validate_layout(layout) == []
    layout["optical"][0]["feedline"] = "Z"
    assert any("unknown feedline" in m for m in validate_layout(layout))

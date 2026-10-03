"""Experiment setup designer: layout validation, evaluation, and defaults.

A layout is the structured schematic of what is installed in a testbed
for one experiment setup (spec 2026-09-09-setup-designer-design.md):
temperature stages, RF chains as ordered parts, switches that route
between chains, and optical parts recorded on stages.

Parts are stored in signal order: input chains warm to cold, output
chains cold to warm. Switch ports are the only connectivity. Evaluation
is a classical (Rayleigh–Jeans) estimate at the layout's frequency.

``validate_layout``, ``evaluate_layout``, and ``default_layout`` are pure;
``validate_layout_references`` and ``load_instrument_values`` read the
catalog. The service layer calls all of them on every layout write.
"""

from __future__ import annotations

import json
import math
import uuid
from functools import lru_cache
from pathlib import Path

from sqlmodel import Session, select

from labcore.models.base import EntityRegistry, utcnow
from labcore.models.entities import Device, Instrument

EVALUATOR_VERSION = 1
LAYOUT_VERSION = 1
CONVENTION = "classical"
ASSUMPTIONS = [
    "matched components",
    "isothermal passive parts at stage temperature",
    "paramp as phase insensitive amplifier",
    "added noise excludes source noise",
]
DEFAULT_FREQUENCY_GHZ = 6.0
# A feedline with no chip: a through line used to calibrate transmission.
THROUGH_DEVICE = "through"
DEFAULT_BASE_TEMP_K = 0.02

_LIBRARY_PATH = Path(__file__).parent / "assets" / "rf_parts.json"
_DIRECTIONS = ("input", "output")
_FRIDGE_KINDS = {"dilution_refrigerator", "adr", "lhe_dewar"}


@lru_cache(maxsize=1)
def load_library() -> dict:
    """The parts library as ``{"version": int, "parts": {id: part}}``."""
    with _LIBRARY_PATH.open(encoding="utf-8") as handle:
        raw = json.load(handle)
    return {
        "version": int(raw["version"]),
        "parts": {part["id"]: part for part in raw["parts"]},
    }


def library_as_list(library: dict) -> dict:
    return {"version": library["version"], "parts": list(library["parts"].values())}


# ---------------------------------------------------------------- validation


def _is_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _device_facing_index(chain: dict) -> int:
    """Array index of the part nearest the device: last for input, first for output."""
    return len(chain["parts"]) - 1 if chain["direction"] == "input" else 0


def _switch_facing_part(chain: dict) -> dict | None:
    """The branch's part nearest its parent switch: first for input, last for output."""
    parts = chain.get("parts") or []
    if not parts:
        return None
    return parts[0] if chain["direction"] == "input" else parts[-1]


def _terminal_switch(chain: dict, library: dict) -> dict | None:
    parts = chain.get("parts") or []
    if not parts:
        return None
    part = parts[_device_facing_index(chain)]
    spec = library["parts"].get(part.get("type"))
    if spec and spec.get("ports", 0) > 0:
        return part
    return None


def _parent_map(layout: dict, library: dict) -> dict[str, tuple[dict, dict, int]]:
    """chain id -> (parent chain, switch part, port) for every referenced chain.

    Only well-formed switch ports are followed; validation reports the
    malformed ones separately.
    """
    parents: dict[str, tuple[dict, dict, int]] = {}
    for chain in layout.get("chains") or []:
        for part in chain.get("parts") or []:
            ports = part.get("ports")
            if not isinstance(ports, dict):
                continue
            for key, target in ports.items():
                if not isinstance(target, str) or target in parents:
                    continue
                try:
                    port = int(key)
                except (TypeError, ValueError):
                    continue
                parents[target] = (chain, part, port)
    return parents


def validate_layout(layout: object, library: dict | None = None) -> list[str]:
    """Document-only validation; an empty list means valid."""
    library = library or load_library()
    errors: list[str] = []
    if not isinstance(layout, dict):
        return ["layout must be an object"]
    if layout.get("version") != LAYOUT_VERSION:
        errors.append(f"layout version must be {LAYOUT_VERSION}")
    frequency = layout.get("frequency_ghz", DEFAULT_FREQUENCY_GHZ)
    if not _is_number(frequency) or frequency <= 0:
        errors.append("frequency_ghz must be a positive number")

    stages = layout.get("stages")
    stage_index: dict[str, int] = {}
    if not isinstance(stages, list) or not stages:
        errors.append("stages must be a non-empty list")
        stages = []
    previous_temp: float | None = None
    for position, stage in enumerate(stages):
        if not isinstance(stage, dict) or not isinstance(stage.get("id"), str) or not stage["id"]:
            errors.append(f"stage {position} needs a string id")
            continue
        if stage["id"] in stage_index:
            errors.append(f"duplicate stage id {stage['id']!r}")
        stage_index[stage["id"]] = position
        temp = stage.get("temp_k")
        if not _is_number(temp) or temp <= 0:
            errors.append(f"stage {stage['id']!r} needs temp_k > 0")
            continue
        if previous_temp is not None and temp >= previous_temp:
            errors.append(
                f"stage {stage['id']!r} must be colder than the stage before it"
            )
        previous_temp = temp

    chains = layout.get("chains")
    if not isinstance(chains, list):
        errors.append("chains must be a list")
        chains = []
    chain_ids: dict[str, dict] = {}
    part_ids: set[str] = set()
    for position, chain in enumerate(chains):
        if not isinstance(chain, dict) or not isinstance(chain.get("id"), str) or not chain["id"]:
            errors.append(f"chain {position} needs a string id")
            continue
        if chain["id"] in chain_ids:
            errors.append(f"duplicate chain id {chain['id']!r}")
        chain_ids[chain["id"]] = chain
        if chain.get("direction") not in _DIRECTIONS:
            errors.append(f"chain {chain['id']!r} direction must be input or output")
            continue
        parts = chain.get("parts")
        if not isinstance(parts, list):
            errors.append(f"chain {chain['id']!r} parts must be a list")
            chain["parts"] = []
            continue
        last_stage: int | None = None
        for index, part in enumerate(parts):
            if not isinstance(part, dict) or not isinstance(part.get("id"), str) or not part["id"]:
                errors.append(f"chain {chain['id']!r} part {index} needs a string id")
                continue
            if part["id"] in part_ids:
                errors.append(f"duplicate part id {part['id']!r}")
            part_ids.add(part["id"])
            spec = library["parts"].get(part.get("type"))
            if spec is None:
                errors.append(f"part {part['id']!r} has unknown type {part.get('type')!r}")
                continue
            if chain["direction"] not in spec.get("directions", []):
                errors.append(
                    f"part {part['id']!r} ({spec['label']}) is not allowed on an "
                    f"{chain['direction']} chain"
                )
            if part.get("stage") not in stage_index:
                errors.append(f"part {part['id']!r} references unknown stage {part.get('stage')!r}")
            else:
                stage = stage_index[part["stage"]]
                if last_stage is not None:
                    out_of_order = (
                        stage < last_stage if chain["direction"] == "input" else stage > last_stage
                    )
                    if out_of_order:
                        errors.append(
                            f"part {part['id']!r} breaks stage order on chain {chain['id']!r}"
                        )
                last_stage = stage
            if part.get("instrument_id") is not None:
                if not spec.get("bindable"):
                    errors.append(f"part {part['id']!r} ({spec['label']}) cannot bind an instrument")
                elif not isinstance(part["instrument_id"], str):
                    errors.append(f"part {part['id']!r} instrument_id must be a string")
            port_count = int(spec.get("ports", 0))
            if port_count > 0:
                if index != _device_facing_index(chain):
                    errors.append(
                        f"switch {part['id']!r} must be the device facing part of chain {chain['id']!r}"
                    )
                ports = part.get("ports")
                if not isinstance(ports, dict):
                    errors.append(f"switch {part['id']!r} needs a ports object")
                    ports = {}
                for key, target in ports.items():
                    try:
                        number = int(key)
                    except (TypeError, ValueError):
                        number = -1
                    if number < 1 or number > port_count:
                        errors.append(f"switch {part['id']!r} port {key!r} is outside 1..{port_count}")
                    if not isinstance(target, str):
                        errors.append(f"switch {part['id']!r} port {key!r} must name a chain")
                selected = part.get("selected_port")
                if selected is not None and str(selected) not in ports:
                    errors.append(f"switch {part['id']!r} selected_port {selected!r} is not a wired port")
            elif part.get("ports"):
                errors.append(f"part {part['id']!r} is not a switch and cannot have ports")

    # Connectivity: every port target exists, has one parent, matches
    # direction, keeps stage order, and no chain reaches itself.
    parents: dict[str, tuple[dict, dict, int]] = {}
    for chain in chain_ids.values():
        for part in chain.get("parts") or []:
            ports = part.get("ports")
            if not isinstance(ports, dict):
                continue
            switch_stage = stage_index.get(part.get("stage"), 0)
            for key, target in ports.items():
                if not isinstance(target, str):
                    continue
                branch = chain_ids.get(target)
                if branch is None:
                    errors.append(f"switch {part.get('id')!r} port {key} points at missing chain {target!r}")
                    continue
                if target in parents:
                    errors.append(f"chain {target!r} is wired to more than one switch port")
                    continue
                parents[target] = (chain, part, int(key) if str(key).isdigit() else 0)
                if branch.get("direction") != chain.get("direction"):
                    errors.append(f"branch {target!r} must have the same direction as chain {chain['id']!r}")
                facing = _switch_facing_part(branch)
                if facing is not None and facing.get("stage") in stage_index:
                    if stage_index[facing["stage"]] < switch_stage:
                        errors.append(
                            f"branch {target!r} starts on a warmer stage than switch {part.get('id')!r}"
                        )
    for chain_id in chain_ids:
        seen = {chain_id}
        current = chain_id
        while current in parents:
            current = parents[current][0]["id"]
            if current in seen:
                errors.append(f"chain {chain_id!r} is part of a switch cycle")
                break
            seen.add(current)

    # Feedlines: leaves need one, switch-ended chains must not have one,
    # and a label pairs at most one chain per direction.
    labels: dict[tuple[str, str], str] = {}
    for chain in chain_ids.values():
        if chain.get("direction") not in _DIRECTIONS:
            continue
        feedline = chain.get("feedline")
        if _terminal_switch(chain, library) is not None:
            if feedline:
                errors.append(f"chain {chain['id']!r} ends in a switch and cannot carry a feedline")
            continue
        if not isinstance(feedline, str) or not feedline.strip():
            errors.append(f"chain {chain['id']!r} needs a feedline label")
            continue
        key = (chain["direction"], feedline.strip())
        if key in labels:
            errors.append(
                f"feedline {feedline!r} is on two {chain['direction']} chains "
                f"({labels[key]!r} and {chain['id']!r})"
            )
        labels[key] = chain["id"]

    feedlines = layout.get("feedlines", {})
    if not isinstance(feedlines, dict):
        errors.append("feedlines must be an object keyed by feedline label")
    else:
        for label, binding in feedlines.items():
            if not isinstance(label, str) or not label.strip():
                errors.append("feedline keys must be non-empty strings")
                continue
            if not isinstance(binding, dict):
                errors.append(f"feedline {label!r} binding must be an object")
                continue
            device_id = binding.get("device_id")
            if device_id is not None and not isinstance(device_id, str):
                errors.append(f"feedline {label!r} device_id must be a string")

    optical = layout.get("optical", [])
    if not isinstance(optical, list):
        errors.append("optical must be a list")
        optical = []
    for index, part in enumerate(optical):
        if not isinstance(part, dict) or not isinstance(part.get("id"), str) or not part["id"]:
            errors.append(f"optical part {index} needs a string id")
            continue
        if part["id"] in part_ids:
            errors.append(f"duplicate part id {part['id']!r}")
        part_ids.add(part["id"])
        spec = library["parts"].get(part.get("type"))
        if spec is None or spec.get("category") != "optical":
            errors.append(f"optical part {part['id']!r} has non-optical type {part.get('type')!r}")
        if part.get("stage") not in stage_index:
            errors.append(f"optical part {part['id']!r} references unknown stage {part.get('stage')!r}")
        # Fibers end on a device: they name the feedline whose device
        # they illuminate rather than sitting on a stage.
        feedline = part.get("feedline")
        if feedline is not None:
            if not isinstance(feedline, str) or ("optical", feedline.strip()) in labels or not any(
                key[1] == feedline.strip() for key in labels
            ):
                errors.append(
                    f"optical part {part['id']!r} points at unknown feedline {feedline!r}"
                )
    return errors


def layout_instrument_ids(layout: dict) -> set[uuid.UUID]:
    ids: set[uuid.UUID] = set()
    for chain in layout.get("chains") or []:
        for part in chain.get("parts") or []:
            value = part.get("instrument_id")
            if isinstance(value, str):
                try:
                    ids.add(uuid.UUID(value))
                except ValueError:
                    continue
    return ids


def layout_device_ids(layout: dict) -> set[uuid.UUID]:
    ids: set[uuid.UUID] = set()
    for binding in (layout.get("feedlines") or {}).values():
        value = binding.get("device_id") if isinstance(binding, dict) else None
        if isinstance(value, str):
            try:
                ids.add(uuid.UUID(value))
            except ValueError:
                continue
    return ids


def layout_bound_ids(layout: dict) -> set[uuid.UUID]:
    """Every catalog record the layout binds: amplifiers and devices."""
    return layout_instrument_ids(layout) | layout_device_ids(layout)


def validate_layout_references(session: Session, layout: dict) -> list[str]:
    """Every bound instrument_id must be a catalog instrument, every
    feedline device_id a catalog device."""
    errors: list[str] = []
    for label, binding in (layout.get("feedlines") or {}).items():
        value = binding.get("device_id") if isinstance(binding, dict) else None
        if value is None or value == THROUGH_DEVICE:
            continue
        try:
            device_id = uuid.UUID(str(value))
        except ValueError:
            errors.append(f"feedline {label!r} device_id is not a UUID")
            continue
        reg = session.get(EntityRegistry, device_id)
        if reg is None or reg.entity_type != "device":
            errors.append(f"feedline {label!r} is bound to a non-device {value}")
    for chain in layout.get("chains") or []:
        for part in chain.get("parts") or []:
            value = part.get("instrument_id")
            if value is None:
                continue
            try:
                instrument_id = uuid.UUID(str(value))
            except ValueError:
                errors.append(f"part {part.get('id')!r} instrument_id is not a UUID")
                continue
            reg = session.get(EntityRegistry, instrument_id)
            if reg is None or reg.entity_type != "instrument":
                errors.append(f"part {part.get('id')!r} is bound to a non-instrument {value}")
    return errors


def load_device_values(session: Session, ids: set[uuid.UUID]) -> dict[str, dict]:
    """Bound devices' identity keyed by id string; absent ids are missing."""
    if not ids:
        return {}
    rows = session.exec(
        select(Device, EntityRegistry)
        .join(EntityRegistry, EntityRegistry.id == Device.id)  # type: ignore[arg-type]
        .where(Device.id.in_(ids))  # type: ignore[attr-defined]
    ).all()
    return {
        str(device.id): {"id": str(device.id), "name": device.name, "accession": reg.accession}
        for device, reg in rows
    }


def load_instrument_values(session: Session, ids: set[uuid.UUID]) -> dict[str, dict]:
    """Bound amplifiers' catalog values keyed by id string; absent ids are missing."""
    if not ids:
        return {}
    rows = session.exec(
        select(Instrument, EntityRegistry)
        .join(EntityRegistry, EntityRegistry.id == Instrument.id)  # type: ignore[arg-type]
        .where(Instrument.id.in_(ids))  # type: ignore[attr-defined]
    ).all()
    values: dict[str, dict] = {}
    for instrument, reg in rows:
        values[str(instrument.id)] = {
            "gain_db": instrument.extra.get("gain_db"),
            "noise_temp_k": instrument.extra.get("noise_temp_k"),
            "name": instrument.name,
            "accession": reg.accession,
        }
    return values


# ---------------------------------------------------------------- evaluation


def _db_to_linear(gain_db: float) -> float:
    return 10 ** (gain_db / 10)


def _linear_to_db(gain: float) -> float:
    return 10 * math.log10(gain) if gain > 0 else -math.inf


def _resolve_part(
    part: dict, library: dict, instruments: dict[str, dict], warnings: list[dict]
) -> tuple[float, float | None, str]:
    """(gain_db, noise_temp_k or None for passive, source)."""
    spec = library["parts"][part["type"]]
    gain_db = float(spec.get("gain_db") or 0.0)
    noise = spec.get("noise_temp_k")
    source = "library"
    instrument_id = part.get("instrument_id")
    if instrument_id is not None:
        record = instruments.get(str(instrument_id))
        if record is None:
            source = "missing_instrument"
            warnings.append(
                {
                    "part": part["id"],
                    "message": f"{spec['label']} is bound to an instrument that no longer exists; library values used",
                }
            )
        else:
            if _is_number(record.get("gain_db")):
                gain_db = float(record["gain_db"])
                source = "instrument"
            if _is_number(record.get("noise_temp_k")):
                noise = float(record["noise_temp_k"])
                source = "instrument"
            if source != "instrument":
                warnings.append(
                    {
                        "part": part["id"],
                        "message": f"{record.get('accession') or instrument_id} has no gain or noise values; library values used",
                    }
                )
    elif spec.get("bindable"):
        warnings.append(
            {
                "part": part["id"],
                "message": f"{spec['label']} is not bound to an instrument; library values used",
            }
        )
    if spec.get("category") == "amplifier":
        return gain_db, float(noise if noise is not None else 0.0), source
    return gain_db, None, source


def _round(value: float) -> float:
    return float(f"{value:.6g}")


def _walk_active(
    root: dict, chains: dict[str, dict], library: dict, warnings: list[dict]
) -> tuple[list[dict], dict | None]:
    """Follow selected ports from a root chain; returns (path chains, leaf or None)."""
    path = [root]
    current = root
    while True:
        switch = _terminal_switch(current, library)
        if switch is None:
            return path, current
        selected = switch.get("selected_port")
        if selected is None:
            warnings.append(
                {"chain": current["id"], "message": f"switch {switch['id']} has no selected port"}
            )
            return path, None
        target = switch["ports"].get(str(selected))
        branch = chains.get(target) if isinstance(target, str) else None
        if branch is None or branch in path:
            return path, None
        path.append(branch)
        current = branch


def _side_parts(path: list[dict]) -> list[dict]:
    """The parts along a path in signal order (chains concatenated)."""
    return [part for chain in path for part in chain.get("parts") or []]


def _evaluate_input(
    path: list[dict], stages: dict[str, float], warm_temp: float,
    library: dict, instruments: dict[str, dict], warnings: list[dict],
) -> dict:
    t_line = warm_temp
    attenuation = 0.0
    parts_out = []
    for part in _side_parts(path):
        gain_db, _noise, source = _resolve_part(part, library, instruments, warnings)
        t_stage = stages[part["stage"]]
        loss = 1.0 / _db_to_linear(min(gain_db, 0.0))
        noise_k = (loss - 1.0) * t_stage
        t_line = t_line / loss + (1.0 - 1.0 / loss) * t_stage
        attenuation += -gain_db
        parts_out.append(
            {
                "id": part["id"],
                "type": part["type"],
                "stage": part["stage"],
                "gain_db": _round(gain_db),
                "noise_k": _round(noise_k),
                "line_noise_after_k": _round(t_line),
                "source": source,
            }
        )
    return {
        "active": True,
        "chain_path": [chain["id"] for chain in path],
        "attenuation_db": _round(attenuation),
        "noise_temp_at_device_k": _round(t_line),
        "parts": parts_out,
    }


def _evaluate_output(
    path: list[dict], stages: dict[str, float],
    library: dict, instruments: dict[str, dict], warnings: list[dict],
) -> dict:
    # Signal order is device outward: the leaf first, then each parent
    # chain starting with its switch. ``path`` is root first, so reverse.
    ordered = list(reversed(path))
    gain_ahead = 1.0
    added = 0.0
    total_db = 0.0
    parts_out = []
    for part in _side_parts(ordered):
        gain_db, amp_noise, source = _resolve_part(part, library, instruments, warnings)
        t_stage = stages[part["stage"]]
        g = _db_to_linear(gain_db)
        if amp_noise is not None:
            noise_k = amp_noise
        else:
            loss = 1.0 / g if g > 0 else math.inf
            noise_k = (loss - 1.0) * t_stage
        contribution = noise_k / gain_ahead
        parts_out.append(
            {
                "id": part["id"],
                "type": part["type"],
                "stage": part["stage"],
                "gain_db": _round(gain_db),
                "noise_k": _round(noise_k),
                "gain_ahead_db": _round(_linear_to_db(gain_ahead)),
                "contribution_k": _round(contribution),
                "source": source,
            }
        )
        added += contribution
        gain_ahead *= g
        total_db += gain_db
    return {
        "active": True,
        "chain_path": [chain["id"] for chain in path],
        "gain_db": _round(total_db),
        "added_noise_k": _round(added),
        "parts": parts_out,
    }


def evaluate_layout(
    layout: dict,
    library: dict | None = None,
    instruments: dict[str, dict] | None = None,
    devices: dict[str, dict] | None = None,
) -> dict:
    """Classical gain and noise per feedline. The layout must be valid.

    ``devices`` maps bound device ids to identity so each feedline in the
    result can name its device (or report it missing)."""
    library = library or load_library()
    instruments = instruments or {}
    devices = devices or {}
    warnings: list[dict] = []
    stages = {stage["id"]: float(stage["temp_k"]) for stage in layout["stages"]}
    warm_temp = float(layout["stages"][0]["temp_k"])
    chains = {chain["id"]: chain for chain in layout.get("chains") or []}
    referenced = {
        target
        for chain in chains.values()
        for part in chain.get("parts") or []
        for target in (part.get("ports") or {}).values()
    }
    roots = [chain for chain in chains.values() if chain["id"] not in referenced]

    # Which leaf each root reaches, and the path to it, per direction.
    active_paths: dict[str, list[dict]] = {}
    for root in roots:
        path, leaf = _walk_active(root, chains, library, warnings)
        if leaf is not None:
            active_paths[leaf["id"]] = path

    def path_to(chain: dict) -> list[dict]:
        path = [chain]
        current = chain
        parents = _parent_map(layout, library)
        while current["id"] in parents:
            current = parents[current["id"]][0]
            path.insert(0, current)
        return path

    feedlines: dict[str, dict] = {}
    for chain in chains.values():
        if _terminal_switch(chain, library) is not None:
            continue
        label = str(chain.get("feedline", "")).strip()
        entry = feedlines.setdefault(label, {"input": None, "output": None})
        if chain["id"] in active_paths:
            path = active_paths[chain["id"]]
            if chain["direction"] == "input":
                entry["input"] = _evaluate_input(path, stages, warm_temp, library, instruments, warnings)
            else:
                entry["output"] = _evaluate_output(path, stages, library, instruments, warnings)
        else:
            entry[chain["direction"]] = {
                "active": False,
                "chain_path": [item["id"] for item in path_to(chain)],
            }
    bindings = layout.get("feedlines") or {}
    for label, entry in feedlines.items():
        if entry["input"] is None:
            warnings.append({"feedline": label, "message": "no input chain"})
        if entry["output"] is None:
            warnings.append({"feedline": label, "message": "no output chain"})
        binding = bindings.get(label) if isinstance(bindings, dict) else None
        device_id = binding.get("device_id") if isinstance(binding, dict) else None
        if device_id is None:
            entry["device"] = None
        elif device_id == THROUGH_DEVICE:
            entry["device"] = {"id": THROUGH_DEVICE, "name": "Through", "through": True}
        elif str(device_id) in devices:
            entry["device"] = devices[str(device_id)]
        else:
            entry["device"] = {"id": str(device_id), "missing": True}
            warnings.append(
                {"feedline": label, "message": "bound device no longer exists"}
            )

    return {
        "evaluator_version": EVALUATOR_VERSION,
        "library_version": library["version"],
        "frequency_ghz": layout.get("frequency_ghz", DEFAULT_FREQUENCY_GHZ),
        "convention": CONVENTION,
        "assumptions": list(ASSUMPTIONS),
        "feedlines": dict(sorted(feedlines.items())),
        "warnings": warnings,
    }


def evaluation_snapshot(evaluation: dict) -> dict:
    return {**evaluation, "evaluated_at": utcnow().isoformat()}


# ------------------------------------------------------------------ defaults


def _temp_label(temp_k: float) -> str:
    if temp_k >= 1:
        return f"{temp_k:g} K"
    return f"{temp_k * 1000:g} mK"


def normalize_kind(kind: str | None) -> str | None:
    """Map free text testbed kinds ("Dilution refriderator", "ADR") onto
    the template's values so pre-select records still get a fridge default."""
    if not kind:
        return None
    text = kind.strip().lower()
    if "dilution" in text or "dil " in text or text in {"dr", "df"}:
        return "dilution_refrigerator"
    if "adr" in text or "adiabatic" in text:
        return "adr"
    if "dewar" in text or "lhe" in text or "helium" in text:
        return "lhe_dewar"
    if "probe" in text:
        return "probe_station"
    if "breadboard" in text or "optical" in text or "photonic" in text:
        return "optical_breadboard"
    return text.replace(" ", "_")


def default_layout(kind: str | None, base_temp_k: float | None) -> dict:
    """The built in starting layout for a testbed kind."""
    kind = normalize_kind(kind)
    notes = ""
    if kind == "optical_breadboard":
        return {
            "version": LAYOUT_VERSION,
            "frequency_ghz": DEFAULT_FREQUENCY_GHZ,
            "stages": [{"id": "table", "label": "Table 300 K", "temp_k": 300}],
            "chains": [],
            "optical": [],
            "notes": notes,
        }
    if kind not in _FRIDGE_KINDS:
        return {
            "version": LAYOUT_VERSION,
            "frequency_ghz": DEFAULT_FREQUENCY_GHZ,
            "stages": [{"id": "rt", "label": "300 K", "temp_k": 300}],
            "chains": [
                {"id": "in1", "label": "Input 1", "direction": "input", "feedline": "A", "parts": []},
                {"id": "out1", "label": "Output 1", "direction": "output", "feedline": "A", "parts": []},
            ],
            "optical": [],
            "notes": notes,
        }
    if base_temp_k is None or base_temp_k <= 0:
        base_temp_k = DEFAULT_BASE_TEMP_K
        notes = "base temperature assumed 20 mK; set it on the testbed"
    # 300 K, the 50 K shield, the 4 K plate, one intermediate stage
    # (still for a dilution fridge, 800 mK for an ADR), and the base stage
    # at the testbed's temperature. Adjust and "Save as testbed default".
    stages: list[dict] = [
        {"id": "rt", "label": "300 K", "temp_k": 300},
        {"id": "50k", "label": "50 K", "temp_k": 50},
        {"id": "4k", "label": "4 K", "temp_k": 4},
    ]
    if kind == "dilution_refrigerator":
        stages.append({"id": "still", "label": "Still", "temp_k": 0.8})
    elif kind == "adr":
        stages.append({"id": "adr1", "label": "800 mK", "temp_k": 0.8})
    if base_temp_k >= 0.8 and len(stages) == 4:
        stages.pop()  # a warm base leaves no room for the intermediate stage
    stages.append({"id": "mxc", "label": _temp_label(base_temp_k), "temp_k": base_temp_k})
    middle = stages[3]["id"] if len(stages) == 5 else "mxc"
    coax_stage = middle
    input_parts = [{"id": "in1-a", "type": "attenuator_20db", "stage": "4k"}]
    if kind == "dilution_refrigerator" and middle != "mxc":
        input_parts.append({"id": "in1-b", "type": "attenuator_20db", "stage": "still"})
    input_parts.append({"id": "in1-c", "type": "attenuator_20db", "stage": "mxc"})
    return {
        "version": LAYOUT_VERSION,
        "frequency_ghz": DEFAULT_FREQUENCY_GHZ,
        "stages": stages,
        "chains": [
            {"id": "in1", "label": "Input 1", "direction": "input", "feedline": "A", "parts": input_parts},
            {
                "id": "out1",
                "label": "Output 1",
                "direction": "output",
                "feedline": "A",
                "parts": [
                    {"id": "out1-a", "type": "isolator", "stage": "mxc"},
                    {"id": "out1-b", "type": "coax_nbti", "stage": coax_stage},
                    {"id": "out1-c", "type": "hemt", "stage": "4k"},
                ],
            },
        ],
        "optical": [],
        "notes": notes,
    }


def set_coldest_stage_temp(layout: dict, temp_k: float) -> dict:
    """Rewrite the coldest stage's temperature and label (setup base temperature)."""
    stages = layout.get("stages") or []
    # A single stage layout (probe station, breadboard) has no cold stage
    # to rewrite; only fridges carry a base temperature.
    if len(stages) < 2 or not _is_number(temp_k) or temp_k <= 0:
        return layout
    coldest = stages[-1]
    coldest["temp_k"] = temp_k
    coldest["label"] = _temp_label(temp_k)
    return layout


def instrument_kind_and_base(session: Session, instrument_id: uuid.UUID) -> tuple[str | None, float | None]:
    instrument = session.get(Instrument, instrument_id)
    if instrument is None:
        return None, None
    base_mk = instrument.extra.get("base_temp_mk")
    base_k = float(base_mk) / 1000 if _is_number(base_mk) and base_mk > 0 else None
    return instrument.kind or None, base_k


__all__: list[str] = [
    "ASSUMPTIONS",
    "CONVENTION",
    "EVALUATOR_VERSION",
    "LAYOUT_VERSION",
    "default_layout",
    "evaluate_layout",
    "evaluation_snapshot",
    "instrument_kind_and_base",
    "layout_instrument_ids",
    "library_as_list",
    "load_instrument_values",
    "load_library",
    "set_coldest_stage_temp",
    "validate_layout",
    "validate_layout_references",
]


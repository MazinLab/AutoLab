"""Setup designer tools for LLM agents: the parts library and a setup's
layout with its live and saved evaluations."""

import uuid

from fastmcp import FastMCP
from sqlalchemy.engine import Engine
from sqlmodel import Session

from labcore.rfchain import (
    evaluate_layout,
    layout_device_ids,
    layout_instrument_ids,
    library_as_list,
    load_device_values,
    load_instrument_values,
    load_library,
)
from labcore.service import get_entity


def register_rf_tools(mcp: FastMCP, engine: Engine) -> None:
    @mcp.tool
    def get_rf_parts() -> dict:
        """The RF parts library the setup designer draws from: nominal
        gain and noise temperature at 6 GHz per part type."""
        return library_as_list(load_library())

    @mcp.tool
    def evaluate_setup(setup_id: str) -> dict:
        """An experiment setup's layout with its evaluation against current
        catalog values and the evaluation saved when the layout was
        written (classical convention, per feedline gain and noise)."""
        try:
            key = uuid.UUID(str(setup_id))
        except ValueError as exc:
            raise ValueError("setup_id must be a UUID") from exc
        with Session(engine) as session:
            setup = get_entity(session, key)
            if setup is None or setup.get("entity_type") != "experiment_setup":
                raise ValueError(f"unknown experiment setup: {setup_id}")
            layout = setup.get("layout") or {}
            evaluation = None
            if layout:
                evaluation = evaluate_layout(
                    layout,
                    instruments=load_instrument_values(session, layout_instrument_ids(layout)),
                    devices=load_device_values(session, layout_device_ids(layout)),
                )
            return {
                "layout": layout,
                "evaluation": evaluation,
                "saved_evaluation": setup.get("layout_evaluation") or None,
            }

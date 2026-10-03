# Experiment setup designer

Experiment setup pages gain a **Setup** section: a structured schematic
of what is installed in the testbed. Temperature stages run as bands,
each RF input and output chain is a column of parts (attenuators,
isolators, circulators, coax, filters, switches, HEMTs, paramps), a six
way switch fans out to branch chains, and optical parts (fibers, windows,
filters) are recorded on stages without being modeled. Drag a part from
the palette onto a stage, or use "+ Add to…"; the inspector changes a
part's stage, moves it, binds a HEMT or paramp to its catalog record, and
wires switch ports. Stages and chains can be added, renamed, and removed.

Per feedline the panel shows input attenuation and the noise temperature
arriving at the device, and output gain and input referred added noise,
all at 6 GHz in the **classical (Rayleigh–Jeans) convention** with stage
temperatures as noise temperatures. Bound amplifiers use the gain and
noise temperature on their Experimental Equipment record (two new
optional fields); everything else uses `labcore/assets/rf_parts.json`,
whose placeholder values the lab should correct. The evaluation computed
at save time is stored with the setup, so a historical setup keeps
reading as it did even after library or amplifier values change.

Creating an Experiment Setup offers **Start from**: the testbed's default
layout or any previous setup on that testbed; the coldest stage follows
the form's base temperature. "Save as testbed default" on a setup page
sets what future setups start from. Bound amplifiers are linked to the
setup with `mounted_in` edges. New routes `/api/rf/parts`,
`/api/rf/evaluate`, and `/api/experiment_setup/{id}/layout`; MCP tools
`get_rf_parts` and `evaluate_setup`. Migration `d7f2b9c4e015`.

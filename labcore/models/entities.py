from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import Index, text
from sqlmodel import CheckConstraint, Field, SQLModel

from labcore.models.base import JSON_VARIANT, UTCDateTime


class TypedEntityMixin(SQLModel):
    """Fields shared by every typed entity table.

    ``id`` joins the typed row to its opaque identity in ``entity_registry``;
    human accession codes are labels and must not be parsed as identity.
    ``extra`` stores payload fields not modeled as typed columns so ingestion
    preserves unknown metadata.
    """

    id: uuid.UUID = Field(primary_key=True, foreign_key="entity_registry.id")
    name: str = Field(default="", index=True)
    description: str = ""
    extra: dict = Field(default_factory=dict, sa_type=JSON_VARIANT)


class ProjectStatus(StrEnum):
    ACTIVE = "active"
    ON_HOLD = "on_hold"
    COMPLETED = "completed"


class Project(TypedEntityMixin, table=True):
    """A scientific or engineering effort that groups related catalog work.

    The top level container: work records point at it through
    ``project_id`` (see ``ProjectMemberMixin``); goals and milestones live
    in ``project_item``.
    """

    __tablename__ = "project"
    status: str = Field(default=ProjectStatus.ACTIVE, index=True)
    lead_id: uuid.UUID | None = Field(
        default=None, foreign_key="entity_registry.id"
    )


class ProjectMemberMixin(SQLModel):
    """Optional membership in one project.

    A plain column rather than a ``part_of`` edge: membership is not
    ancestry, so it must stay out of lineage graphs and dotted labels.
    ``Field(foreign_key=...)`` builds a fresh column per table, so the
    mixin is safe to share (unlike a ``Column`` object).
    """

    project_id: uuid.UUID | None = Field(
        default=None, foreign_key="project.id", index=True
    )


class Person(TypedEntityMixin, table=True):
    """A human actor who can own work or receive catalog attribution."""

    __tablename__ = "person"
    # Partial unique index: identity resolution binds a login to exactly one
    # person; the service pre-check gives the friendly error, this closes
    # the concurrent-create race. Empty logins stay unconstrained.
    __table_args__ = (
        Index(
            "uq_person_tailscale_login",
            "tailscale_login",
            unique=True,
            postgresql_where=text("tailscale_login != ''"),
            sqlite_where=text("tailscale_login != ''"),
        ),
    )
    email: str = ""
    tailscale_login: str = ""
    # Slack member id (U... / W...), recorded so notification DMs can
    # resolve people from day one (Autolab-lux).
    slack_id: str = ""


class PersonNetworkIdentity(SQLModel, table=True):
    """A network login alias that resolves to one catalog person."""

    __tablename__ = "person_network_identity"
    login: str = Field(primary_key=True)
    person_id: uuid.UUID = Field(
        foreign_key="person.id", ondelete="CASCADE", index=True
    )


class Agent(TypedEntityMixin, table=True):
    """An automated actor, optionally operated by a registered person."""

    __tablename__ = "agent"
    model: str = ""
    operator_id: uuid.UUID | None = Field(
        default=None, foreign_key="person.id"
    )


class Instrument(TypedEntityMixin, table=True):
    """Laboratory hardware used for fabrication, testing, or measurement."""

    __tablename__ = "instrument"
    kind: str = ""
    # Coarse split for equipment pickers: "testbed" (fridges, probe
    # stations, breadboards), "experimental" (VNA, readout), or "fab"
    # (sputters, etchers, XRD). Empty means uncategorized.
    category: str = ""
    location: str = ""
    # Testbeds only: the setup designer layout new setups start from
    # (see labcore.rfchain). Empty means "use the built in default".
    default_layout: dict = Field(default_factory=dict, sa_type=JSON_VARIANT)


class Design(ProjectMemberMixin, TypedEntityMixin, table=True):
    """A mask/detector design: code reference, layout files, and metadata."""

    __tablename__ = "design"
    repo_url: str = ""
    git_commit: str = ""


class FabRecipe(ProjectMemberMixin, TypedEntityMixin, table=True):
    """A reusable fabrication recipe; the body holds the procedure markdown."""

    __tablename__ = "fab_recipe"
    body: str = ""


class FabStep(TypedEntityMixin, table=True):
    """An ordered fabrication step; wafer, recipe, and machine link by edges.

    The body holds run notes: the values that changed this time (etch
    duration, thickness) against the recipe's stable procedure.
    """

    __tablename__ = "fab_step"
    __table_args__ = (CheckConstraint("step_index >= 0"),)
    step_index: int = 0
    recipe: str = ""
    body: str = ""


class SubstrateBatch(ProjectMemberMixin, TypedEntityMixin, table=True):
    """A supplier box of substrates; QR-labeled physical inventory."""

    __tablename__ = "substrate_batch"
    vendor: str = ""
    material: str = ""
    diameter_mm: float | None = None
    thickness_um: float | None = None
    resistivity: str = ""
    orientation: str = ""
    spec: str = ""
    wafer_count: int | None = None


class Wafer(ProjectMemberMixin, TypedEntityMixin, table=True):
    """A physical substrate processed during detector fabrication."""

    __tablename__ = "wafer"
    material: str = ""
    diameter_mm: float | None = None


class Device(ProjectMemberMixin, TypedEntityMixin, table=True):
    """An individual fabricated or assembled device under study."""

    __tablename__ = "device"
    device_type: str = ""


class ExperimentSetup(ProjectMemberMixin, TypedEntityMixin, table=True):
    """An experimental session: instrument, timing, conditions, and loadout.

    Generalizes the old cooldown entity — a fridge run, probe station
    session, or any other configured measurement session. The body holds
    the setup narrative (wiring, biases, switch matrix) as markdown.
    """

    __tablename__ = "experiment_setup"
    started_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    ended_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    base_temp_mk: float | None = None
    body: str = ""
    # Setup designer document (stages, chains, parts) and the evaluation
    # computed when it was saved, kept so a historical setup still reads
    # as it did even after library or amplifier values change.
    layout: dict = Field(default_factory=dict, sa_type=JSON_VARIANT)
    layout_evaluation: dict = Field(default_factory=dict, sa_type=JSON_VARIANT)


class MeasurementRun(TypedEntityMixin, table=True):
    """A data-taking activity performed with cataloged experimental context."""

    __tablename__ = "measurement_run"
    kind: str = ""
    started_at: datetime | None = Field(default=None, sa_type=UTCDateTime)
    body: str = ""


class AnalysisRun(ProjectMemberMixin, TypedEntityMixin, table=True):
    """A reproducible computation that transforms or interprets data."""

    __tablename__ = "analysis_run"
    git_commit: str = ""
    body: str = ""
    # Named results (key -> number or string; units ride in the key name,
    # e.g. base_temp_mk) so result summaries can table them.
    results: dict = Field(default_factory=dict, sa_type=JSON_VARIANT)


class Software(ProjectMemberMixin, TypedEntityMixin, table=True):
    """An analysis or control code package used to produce results."""

    __tablename__ = "software"
    version: str = ""
    git_commit: str = ""
    url: str = ""


class ResultSummary(TypedEntityMixin, table=True):
    """A table of analyses bearing on one idea, across projects.

    Rows are analyses linked by ``analysis_run REFERS_TO result_summary``;
    columns are the analyses' result keys. ``columns`` optionally fixes the
    shown keys, order, and labels ([{"key": ..., "label": ...}]); empty
    means every key seen.
    """

    __tablename__ = "result_summary"
    body: str = ""
    columns: list = Field(default_factory=list, sa_type=JSON_VARIANT)


class ArtifactRole(StrEnum):
    RAW = "raw"
    CALIBRATED = "calibrated"
    DERIVED = "derived"
    PRESENTATION = "presentation"


class Artifact(TypedEntityMixin, table=True):
    """Metadata for a stored file or data product, including integrity fields."""

    __tablename__ = "artifact"
    uri: str = ""
    checksum_sha256: str = ""
    size_bytes: int | None = None
    media_type: str = ""
    data_format: str = ""
    schema_version: str = ""
    role: str = ""


class Note(ProjectMemberMixin, TypedEntityMixin, table=True):
    """A narrative electronic-lab-notebook record in the catalog."""

    __tablename__ = "note"
    body: str = ""
    template: str = ""


class ReviewTask(TypedEntityMixin, table=True):
    """A proposed annotation or other judgment awaiting tracked review."""

    __tablename__ = "review_task"
    kind: str = ""
    status: str = "open"


ENTITY_TYPES: dict[str, type[SQLModel]] = {
    "project": Project,
    "person": Person,
    "agent": Agent,
    "instrument": Instrument,
    "design": Design,
    "fab_recipe": FabRecipe,
    "fab_step": FabStep,
    "substrate_batch": SubstrateBatch,
    "wafer": Wafer,
    "device": Device,
    "experiment_setup": ExperimentSetup,
    "measurement_run": MeasurementRun,
    "analysis_run": AnalysisRun,
    "software": Software,
    "result_summary": ResultSummary,
    "artifact": Artifact,
    "note": Note,
    "review_task": ReviewTask,
}

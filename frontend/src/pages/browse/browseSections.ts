import type { Entity, EntityType, Pagination } from "../../api/client";

export interface BrowseColumn {
  key: string;
  label: string;
  kind?: "number" | "date" | "snippet";
}

export interface BrowseItem {
  slug: string;
  label: string;
  entityType: EntityType;
  /** Server-side list filters applied to every page fetch. */
  serverFilter?: Pick<Pagination, "filters" | "extraFilters">;
  /**
   * Client-side subset filter applied WITHIN each server page. Only used
   * where server equality filters cannot express the subset (see the
   * instrument items); pagination totals then count the whole entity type.
   */
  match?: (entity: Entity) => boolean;
  columns: BrowseColumn[];
}

export interface BrowseSection {
  key: "projects" | "fab" | "testing" | "other";
  title: string;
  items: BrowseItem[];
}

function fieldValue(entity: Entity, key: string): unknown {
  const direct = entity[key];
  if (direct !== undefined && direct !== null) {
    return direct;
  }
  return entity.extra?.[key];
}

/**
 * Equipment lists keep uncategorized instruments visible in both sections.
 * Server equality filters cannot express "no category OR category = wanted",
 * so the two equipment items paginate the full instrument list server-side
 * (no serverFilter) and apply this match within each fetched page.
 */
function instrumentIn(category: string): (entity: Entity) => boolean {
  return (entity) => {
    const value = fieldValue(entity, "category");
    return !value || value === category;
  };
}

/** note.template is a typed column, so template subsets filter server-side. */
function noteTemplateFilter(template: string): Pick<Pagination, "filters"> {
  return { filters: { template } };
}

// Entity types that carry a project_id column, so "?project=" can filter
// their lists server-side.
export const PROJECT_MEMBER_TYPES = new Set<EntityType>([
  "design",
  "fab_recipe",
  "substrate_batch",
  "wafer",
  "device",
  "experiment_setup",
  "analysis_run",
  "software",
  "note",
]);

export const BROWSE_SECTIONS: BrowseSection[] = [
  {
    key: "projects",
    title: "Projects",
    items: [
      {
        slug: "projects",
        label: "Projects",
        entityType: "project",
        columns: [
          { key: "status", label: "Status" },
          { key: "description", label: "Description" },
        ],
      },
    ],
  },
  {
    key: "fab",
    title: "Fab",
    items: [
      {
        slug: "designs",
        label: "Designs",
        entityType: "design",
        columns: [
          { key: "layout_tool", label: "Layout tool" },
          { key: "git_commit", label: "Git commit" },
          { key: "description", label: "Description" },
        ],
      },
      {
        slug: "substrate-batches",
        label: "Substrate Batches",
        entityType: "substrate_batch",
        columns: [
          { key: "vendor", label: "Vendor" },
          { key: "material", label: "Material" },
          { key: "diameter_mm", label: "Diameter (mm)", kind: "number" },
          { key: "wafer_count", label: "Wafers", kind: "number" },
        ],
      },
      {
        slug: "wafers",
        label: "Wafers",
        entityType: "wafer",
        columns: [
          { key: "material", label: "Material" },
          { key: "diameter_mm", label: "Diameter (mm)", kind: "number" },
          { key: "description", label: "Description" },
        ],
      },
      {
        slug: "devices",
        label: "Devices",
        entityType: "device",
        columns: [{ key: "description", label: "Description" }],
      },
      {
        slug: "fab-recipes",
        label: "Fab Recipes",
        entityType: "fab_recipe",
        columns: [{ key: "body", label: "Procedure", kind: "snippet" }],
      },
      {
        slug: "fab-steps",
        label: "Fab Steps",
        entityType: "fab_step",
        columns: [
          { key: "step_index", label: "Step", kind: "number" },
          { key: "description", label: "Description" },
        ],
      },
      {
        slug: "fab-notes",
        label: "Fab Notes",
        entityType: "note",
        serverFilter: noteTemplateFilter("Fab Note"),
        columns: [{ key: "body", label: "Note", kind: "snippet" }],
      },
      {
        slug: "wafer-measurements",
        label: "Wafer Measurements",
        entityType: "measurement_run",
        columns: [
          { key: "kind", label: "Kind" },
          { key: "body", label: "Summary", kind: "snippet" },
        ],
      },
      {
        slug: "fab-equipment",
        label: "Fab Equipment",
        entityType: "instrument",
        match: instrumentIn("fab"),
        columns: [
          { key: "kind", label: "Kind" },
          { key: "location", label: "Location" },
        ],
      },
    ],
  },
  {
    key: "testing",
    title: "Testing",
    items: [
      {
        slug: "testbeds",
        label: "Testbeds",
        entityType: "instrument",
        match: instrumentIn("testbed"),
        columns: [
          { key: "kind", label: "Kind" },
          { key: "location", label: "Location" },
          { key: "base_temp_mk", label: "Base T (mK)", kind: "number" },
        ],
      },
      {
        slug: "experimental-equipment",
        label: "Experimental Equipment",
        entityType: "instrument",
        match: instrumentIn("experimental"),
        columns: [
          { key: "kind", label: "Kind" },
          { key: "location", label: "Location" },
        ],
      },
      {
        slug: "experiment-setups",
        label: "Experiment Setups",
        entityType: "experiment_setup",
        columns: [
          { key: "base_temp_mk", label: "Base T (mK)", kind: "number" },
          { key: "started_at", label: "Started", kind: "date" },
        ],
      },
      {
        slug: "experiments",
        label: "Experiments",
        entityType: "note",
        serverFilter: noteTemplateFilter("Experiment"),
        columns: [{ key: "body", label: "Log", kind: "snippet" }],
      },
      {
        slug: "maintenance",
        label: "Maintenance",
        entityType: "note",
        serverFilter: noteTemplateFilter("Maintenance"),
        columns: [{ key: "body", label: "Note", kind: "snippet" }],
      },
      {
        slug: "analyses",
        label: "Analyses",
        entityType: "analysis_run",
        columns: [
          { key: "git_commit", label: "Git commit" },
          { key: "body", label: "Results", kind: "snippet" },
        ],
      },
      {
        slug: "analysis-software",
        label: "Analysis Software",
        entityType: "software",
        columns: [
          { key: "version", label: "Version" },
          { key: "git_commit", label: "Git commit" },
        ],
      },
      {
        slug: "result-summaries",
        label: "Result Summaries",
        entityType: "result_summary",
        columns: [{ key: "description", label: "Description", kind: "snippet" }],
      },
    ],
  },
  {
    key: "other",
    title: "Everything else",
    items: [
      {
        slug: "notes",
        label: "All Notes",
        entityType: "note",
        columns: [
          { key: "template", label: "Template" },
          { key: "body", label: "Note", kind: "snippet" },
        ],
      },
      {
        slug: "artifacts",
        label: "Artifacts",
        entityType: "artifact",
        columns: [
          { key: "media_type", label: "Media type" },
          { key: "size_bytes", label: "Size (bytes)", kind: "number" },
        ],
      },
      {
        slug: "people",
        label: "People",
        entityType: "person",
        columns: [{ key: "email", label: "Email" }],
      },
      {
        slug: "agents",
        label: "Agents",
        entityType: "agent",
        columns: [{ key: "model", label: "Model" }],
      },
    ],
  },
];

export function findBrowseItem(slug: string | undefined): BrowseItem | null {
  if (!slug) {
    return null;
  }
  for (const section of BROWSE_SECTIONS) {
    const item = section.items.find((candidate) => candidate.slug === slug);
    if (item) {
      return item;
    }
  }
  return null;
}

const SNIPPET_LENGTH = 110;

export function columnText(entity: Entity, column: BrowseColumn): string {
  const value = fieldValue(entity, column.key);
  if (value === undefined || value === null || value === "") {
    return "—";
  }
  switch (column.kind) {
    case "number":
      return typeof value === "number" ? value.toLocaleString() : String(value);
    case "date": {
      const parsed = new Date(String(value));
      return Number.isNaN(parsed.valueOf())
        ? String(value)
        : parsed.toLocaleDateString();
    }
    case "snippet": {
      const flattened = String(value)
        .replaceAll(/^#+\s*/gm, "")
        .replaceAll(/\s+/g, " ")
        .trim();
      return flattened.length > SNIPPET_LENGTH
        ? `${flattened.slice(0, SNIPPET_LENGTH)}…`
        : flattened || "—";
    }
    default:
      return String(value);
  }
}

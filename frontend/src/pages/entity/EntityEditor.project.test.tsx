import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Entity } from "../../api/client";
import { resetDropdownOptionsCache } from "../../components/TemplateForm";
import { EntityEditor, isProjectRequired } from "./EntityEditor";

const apiMocks = vi.hoisted(() => ({
  getSchema: vi.fn(),
  listAllEntities: vi.fn(),
  patchEntity: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    getSchema: apiMocks.getSchema,
    listAllEntities: apiMocks.listAllEntities,
    patchEntity: apiMocks.patchEntity,
  };
});

const uuidProperty = {
  anyOf: [{ type: "string", format: "uuid" }, { type: "null" }],
  default: null,
};

const schemas = {
  project: {
    properties: {
      id: { type: "string", format: "uuid" },
      name: { default: "", title: "Name", type: "string" },
      description: { default: "", title: "Description", type: "string" },
      extra: { additionalProperties: true, type: "object" },
      status: { default: "active", title: "Status", type: "string" },
      lead_id: uuidProperty,
    },
  },
  wafer: {
    properties: {
      id: { type: "string", format: "uuid" },
      name: { default: "", title: "Name", type: "string" },
      description: { default: "", title: "Description", type: "string" },
      extra: { additionalProperties: true, type: "object" },
      material: { default: "", title: "Material", type: "string" },
      project_id: uuidProperty,
    },
  },
};

function record(overrides: Partial<Entity>): Entity {
  return {
    id: "01900000-0000-7000-8000-000000000001",
    accession: "X-2026-0001",
    entity_type: "wafer",
    name: "Thing",
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    version: 1,
    ...overrides,
  };
}

const ben = record({
  id: "person-1",
  accession: "P-2026-0001",
  entity_type: "person",
  name: "Ben",
});
const airBridge = record({
  id: "project-1",
  accession: "PRJ-2026-0001",
  entity_type: "project",
  name: "Air Bridge MKIDs",
  status: "active",
  lead_id: ben.id,
});
const wafer = record({
  id: "wafer-1",
  accession: "W-2026-0001",
  entity_type: "wafer",
  material: "Al",
  project_id: airBridge.id,
});

beforeEach(() => {
  resetDropdownOptionsCache();
  apiMocks.getSchema
    .mockReset()
    .mockResolvedValue({ entity_types: schemas, relations: [] });
  apiMocks.listAllEntities.mockReset().mockImplementation((type: string) =>
    Promise.resolve(type === "project" ? [airBridge] : type === "person" ? [ben] : []),
  );
  apiMocks.patchEntity.mockReset().mockResolvedValue({ data: wafer, etag: '"v2"' });
});

afterEach(() => {
  cleanup();
});

describe("EntityEditor project and lead references", () => {
  it("renders the current project as a dropdown without None on a required table", async () => {
    render(
      <EntityEditor entity={wafer} etag='"v1"' onCancel={vi.fn()} onSaved={vi.fn()} />,
    );
    const select = (await screen.findByLabelText("Project *")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe(airBridge.id);
    expect(select.options[0].textContent).toBe("Select project…");
    expect(isProjectRequired(wafer)).toBe(true);
  });

  it("clears the lead by submitting null", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(
      <EntityEditor entity={airBridge} etag='"v1"' onCancel={vi.fn()} onSaved={onSaved} />,
    );
    const lead = (await screen.findByLabelText("Lead")) as HTMLSelectElement;
    await waitFor(() => expect(lead.disabled).toBe(false));
    expect(lead.value).toBe(ben.id);
    expect(lead.options[0].textContent).toBe("None");
    await user.selectOptions(lead, "");
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(apiMocks.patchEntity).toHaveBeenCalledOnce());
    expect(apiMocks.patchEntity).toHaveBeenCalledWith(
      "project",
      airBridge.id,
      { lead_id: null },
      '"v1"',
    );
  });

  it("treats Experiment notes as project required and other notes as optional", () => {
    expect(
      isProjectRequired(record({ entity_type: "note", template: "Experiment" })),
    ).toBe(true);
    expect(
      isProjectRequired(record({ entity_type: "note", template: "Fab Note" })),
    ).toBe(false);
    expect(isProjectRequired(record({ entity_type: "design" }))).toBe(false);
  });
});

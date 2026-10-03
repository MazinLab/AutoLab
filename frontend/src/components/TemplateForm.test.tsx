import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  type Entity,
  type EntityTemplate,
  type EntityType,
} from "../api/client";
import { TemplateForm } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEdge: vi.fn(),
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  listEntities: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEdge: apiMocks.createEdge,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    listEntities: apiMocks.listEntities,
  };
});

function entity(
  id: string,
  accession: string,
  entityType: EntityType,
  overrides: Partial<Entity> = {},
): Entity {
  return {
    id,
    accession,
    entity_type: entityType,
    name: accession,
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-07-18T20:00:00Z",
    updated_at: "2026-07-18T20:00:00Z",
    version: 0,
    ...overrides,
  };
}

const fabNoteTemplate: EntityTemplate = {
  name: "Fab Note",
  entity_type: "note",
  fields: [
    {
      name: "wafer",
      label: "Wafer",
      type: "entity",
      required: true,
    },
    {
      name: "process_step",
      label: "Process Step",
      type: "text",
    },
  ],
  body: true,
};

const cooldownTemplate: EntityTemplate = {
  name: "Experiment Setup",
  entity_type: "experiment_setup",
  fields: [
    {
      name: "instrument",
      label: "Instrument",
      type: "entity",
      required: true,
    },
    {
      name: "base_temp_mk",
      label: "Base Temperature",
      type: "number",
    },
    {
      name: "started_at",
      label: "Started At",
      type: "datetime",
      required: true,
    },
  ],
  body: false,
};

const fabEquipmentTemplate: EntityTemplate = {
  name: "Fab Equipment",
  entity_type: "instrument",
  defaults: { category: "fab" },
  fields: [
    { name: "name", label: "Common Name", type: "text", required: true },
    { name: "kind", label: "Kind", type: "text" },
  ],
  body: false,
};

const whiteFridge = entity("instrument-1", "INST-2026-0001", "instrument", {
  name: "White Fridge",
  category: "testbed",
  created_at: "2026-07-10T20:00:00Z",
});

const sputter = entity("instrument-2", "INST-2026-0002", "instrument", {
  name: "AJA Sputter",
  category: "fab",
  created_at: "2026-07-15T20:00:00Z",
});

beforeEach(() => {
  apiMocks.createEdge.mockReset().mockResolvedValue({ id: "edge-1" });
  apiMocks.createEntity.mockReset();
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.listEntities.mockReset().mockResolvedValue([whiteFridge, sputter]);
});

afterEach(() => {
  cleanup();
});

const waferRecord = entity("wafer-7", "W-2026-0007", "wafer", {
  name: "W20260720-7",
});

describe("TemplateForm entity references", () => {
  it("offers only fab machines for a fab step and links the pick as performed_on", async () => {
    const createdFabStep = entity("fab-step-2", "FS-2026-0002", "fab_step");
    apiMocks.createEntity.mockResolvedValue(createdFabStep);
    apiMocks.listEntities.mockImplementation((entityType: string) =>
      Promise.resolve(
        entityType === "wafer"
          ? [waferRecord]
          : entityType === "instrument"
            ? [whiteFridge, sputter]
            : [],
      ),
    );
    const user = userEvent.setup();
    render(<TemplateForm template={shippedFabStepTemplate} />);

    const machineDropdown = (await screen.findByLabelText(
      "Machine",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(machineDropdown.options.length).toBe(2);
    });
    // The experimental fridge is filtered out of the fab machine dropdown.
    expect(machineDropdown.options[1].textContent).toContain("AJA Sputter");

    await user.selectOptions(
      screen.getByLabelText("Wafer *"),
      waferRecord.id,
    );
    await user.selectOptions(machineDropdown, sputter.id);
    await user.type(screen.getByLabelText(/Step Index/), "2");
    await user.click(screen.getByRole("button", { name: "Create fab step" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("fab_step", {
        source_key: expect.stringMatching(/^web:/),
        step_index: 2,
        links: [
          { relation: "refers_to", dst_id: waferRecord.id },
          { relation: "performed_on", dst_id: sputter.id },
        ],
      });
    });
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });

  it("stores a fab note's selected wafer as a refers_to link instead of extra data", async () => {
    const createdNote = entity("note-1", "NOTE-2026-0001", "note");
    apiMocks.createEntity.mockResolvedValue(createdNote);
    apiMocks.listEntities.mockImplementation((entityType: string) =>
      Promise.resolve(entityType === "wafer" ? [waferRecord] : []),
    );
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<TemplateForm onCreated={onCreated} template={fabNoteTemplate} />);

    const waferDropdown = (await screen.findByLabelText(
      "Wafer *",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(waferDropdown.options.length).toBe(2);
    });
    await user.selectOptions(waferDropdown, waferRecord.id);
    await user.type(screen.getByLabelText(/Process Step/), "Etch");
    await user.type(screen.getByLabelText("Markdown note"), "Etch went long");
    await user.click(screen.getByRole("button", { name: "Create fab note" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("note", {
        source_key: expect.stringMatching(/^web:/),
        name: "Etch went long",
        body: "Etch went long",
        template: "Fab Note",
        process_step: "Etch",
        links: [{ relation: "refers_to", dst_id: waferRecord.id }],
      });
      expect(onCreated).toHaveBeenCalledWith(createdNote);
    });
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });

  it("sends the cooldown and its instrument link atomically and resubmits after a failure", async () => {
    const createdCooldown = entity("cooldown-1", "CD-2026-0001", "experiment_setup");
    // The whole create (record + links) is one transaction: a failure means
    // nothing was persisted, so retrying resubmits the full payload.
    apiMocks.createEntity
      .mockRejectedValueOnce(new ApiError(503, "database temporarily unavailable"))
      .mockResolvedValue(createdCooldown);
    const onCreated = vi.fn();
    const user = userEvent.setup();
    render(<TemplateForm onCreated={onCreated} template={cooldownTemplate} />);

    const dropdown = (await screen.findByLabelText(
      "Instrument *",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(dropdown.options.length).toBe(2);
    });
    // The fab sputter is filtered out of the testbed dropdown.
    expect(dropdown.options[1].textContent).toContain("White Fridge");
    await user.selectOptions(dropdown, whiteFridge.id);
    await user.type(screen.getByLabelText(/Base Temperature/), "92.5");
    const localDatetime = "2026-07-18T14:30";
    await user.type(screen.getByLabelText(/Started At/), localDatetime);
    await user.click(screen.getByRole("button", { name: "Create experiment setup" }));

    expect(
      await screen.findByText(/database temporarily unavailable/),
    ).toBeTruthy();
    const expectedPayload = {
      source_key: expect.stringMatching(/^web:/),
      base_temp_mk: 92.5,
      started_at: new Date(localDatetime).toISOString(),
      links: [{ relation: "performed_on", dst_id: whiteFridge.id }],
    };
    expect(apiMocks.createEntity).toHaveBeenCalledWith(
      "experiment_setup",
      expectedPayload,
    );
    expect(onCreated).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Create experiment setup" }));

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(createdCooldown);
    });
    expect(apiMocks.createEntity).toHaveBeenCalledTimes(2);
    expect(apiMocks.createEntity).toHaveBeenLastCalledWith(
      "experiment_setup",
      expectedPayload,
    );
    // The resubmit is the SAME logical record: the idempotency key is
    // identical, so a create that silently committed cannot duplicate.
    const [firstCall, secondCall] = apiMocks.createEntity.mock.calls;
    expect((secondCall[1] as { source_key: string }).source_key).toBe(
      (firstCall[1] as { source_key: string }).source_key,
    );
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });
});

const shippedFabStepTemplate: EntityTemplate = {
  name: "Fab Step",
  entity_type: "fab_step",
  fields: [
    { name: "wafer", label: "Wafer", type: "entity", required: true },
    { name: "recipe", label: "Recipe", type: "entity" },
    { name: "instrument", label: "Machine", type: "entity" },
    {
      name: "step_index",
      label: "Step Index",
      type: "number",
      required: true,
    },
  ],
  body: false,
};

const fabRecipeTemplate: EntityTemplate = {
  name: "Fab Recipe",
  entity_type: "fab_recipe",
  fields: [
    { name: "name", label: "Recipe Name", type: "text", required: true },
    { name: "description", label: "Description", type: "text" },
  ],
  body: true,
};

describe("Fab recipes and wafer-anchored fab steps", () => {
  it("saves the recipe procedure markdown on the fab_recipe entity", async () => {
    const createdRecipe = entity("recipe-1", "RCP-2026-0001", "fab_recipe");
    apiMocks.createEntity.mockResolvedValue(createdRecipe);
    const user = userEvent.setup();
    render(<TemplateForm template={fabRecipeTemplate} />);

    await user.type(screen.getByLabelText(/Recipe Name/), "Nb etch v3");
    await user.type(
      screen.getByLabelText("Markdown note"),
      "1. Descum 60s\n2. BCl3 etch",
    );
    await user.click(screen.getByRole("button", { name: "Create fab recipe" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("fab_recipe", {
        source_key: expect.stringMatching(/^web:/),
        name: "Nb etch v3",
        body: "1. Descum 60s\n2. BCl3 etch",
      });
    });
  });

  it("links a fab step to its wafer and recipe through dropdowns", async () => {
    const wafer = entity("wafer-1", "W-2026-0001", "wafer", {
      name: "W20260712-2",
    });
    const recipe = entity("recipe-1", "RCP-2026-0001", "fab_recipe", {
      name: "Nb etch v3",
    });
    const createdStep = entity("fab-step-9", "STEP-2026-0009", "fab_step");
    apiMocks.createEntity.mockResolvedValue(createdStep);
    apiMocks.listEntities.mockImplementation((entityType: string) =>
      Promise.resolve(
        entityType === "wafer"
          ? [wafer]
          : entityType === "fab_recipe"
            ? [recipe]
            : [whiteFridge, sputter],
      ),
    );
    const user = userEvent.setup();
    render(<TemplateForm template={shippedFabStepTemplate} />);

    const waferDropdown = (await screen.findByLabelText(
      "Wafer *",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(waferDropdown.options.length).toBe(2);
    });
    await user.selectOptions(waferDropdown, wafer.id);
    await user.selectOptions(screen.getByLabelText("Recipe"), recipe.id);
    await user.type(screen.getByLabelText(/Step Index/), "3");
    await user.click(screen.getByRole("button", { name: "Create fab step" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("fab_step", {
        source_key: expect.stringMatching(/^web:/),
        step_index: 3,
        links: [
          { relation: "refers_to", dst_id: wafer.id },
          { relation: "refers_to", dst_id: recipe.id },
        ],
      });
    });
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });
});

describe("Equipment templates", () => {
  it("stamps the template's category default onto the created instrument", async () => {
    const createdSputter = entity(
      "instrument-9",
      "INST-2026-0009",
      "instrument",
      { name: "AJA Orion 8", category: "fab" },
    );
    apiMocks.createEntity.mockResolvedValue(createdSputter);
    const user = userEvent.setup();
    render(<TemplateForm template={fabEquipmentTemplate} />);

    await user.type(screen.getByLabelText(/Common Name/), "AJA Orion 8");
    await user.type(screen.getByLabelText(/Kind/), "sputter");
    await user.click(
      screen.getByRole("button", { name: "Create fab equipment" }),
    );

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("instrument", {
        source_key: expect.stringMatching(/^web:/),
        category: "fab",
        name: "AJA Orion 8",
        kind: "sputter",
      });
    });
  });
});

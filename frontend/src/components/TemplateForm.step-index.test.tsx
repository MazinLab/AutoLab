import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Entity,
  type EntityTemplate,
  type EntityType,
} from "../api/client";
import { TemplateForm } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getEntity: vi.fn(),
  getLineageGraph: vi.fn(),
  getPrinters: vi.fn(),
  listEntities: vi.fn(),
  printLabel: vi.fn(),
  searchEntities: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEntity: apiMocks.createEntity,
    getEntity: apiMocks.getEntity,
    getLineageGraph: apiMocks.getLineageGraph,
    getPrinters: apiMocks.getPrinters,
    listEntities: apiMocks.listEntities,
    printLabel: apiMocks.printLabel,
    searchEntities: apiMocks.searchEntities,
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
    created_at: "2026-08-10T10:00:00Z",
    updated_at: "2026-08-10T10:00:00Z",
    version: 0,
    ...overrides,
  };
}

const fabStepTemplate: EntityTemplate = {
  name: "Fab Step",
  entity_type: "fab_step",
  fields: [
    { name: "wafer", label: "Wafer", type: "entity", required: true },
    { name: "recipe", label: "Recipe", type: "entity" },
    { name: "step_index", label: "Step Index", type: "number", required: true },
  ],
  body: false,
};

const bareWafer = entity("wafer-bare", "W-2026-0001", "wafer");
const processedWafer = entity("wafer-processed", "W-2026-0002", "wafer");

function lineageNode(id: string, entityType: EntityType) {
  return { id, entity_type: entityType, accession: id, depth: 1 };
}

beforeEach(() => {
  apiMocks.createEntity.mockReset();
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.printLabel.mockReset();
  apiMocks.searchEntities.mockReset().mockResolvedValue([]);
  apiMocks.listEntities
    .mockReset()
    .mockImplementation((entityType: string) =>
      Promise.resolve(
        entityType === "wafer" ? [bareWafer, processedWafer] : [],
      ),
    );
  // The processed wafer has two logged steps (2 and 5) plus a fab note
  // that must not count; the bare wafer has nothing referring to it.
  apiMocks.getLineageGraph.mockReset().mockImplementation((entityId: string) =>
    Promise.resolve(
      entityId === processedWafer.id
        ? {
            nodes: [
              lineageNode("step-a", "fab_step"),
              lineageNode("step-b", "fab_step"),
              lineageNode("note-a", "note"),
            ],
            edges: [],
          }
        : { nodes: [], edges: [] },
    ),
  );
  apiMocks.getEntity.mockReset().mockImplementation((_: string, id: string) =>
    Promise.resolve({
      data: entity(id, id, "fab_step", {
        step_index: id === "step-b" ? 5 : 2,
      } as Partial<Entity>),
      etag: '"v0"',
    }),
  );
});

afterEach(cleanup);

async function pickWafer(
  user: ReturnType<typeof userEvent.setup>,
  waferId: string,
): Promise<void> {
  const dropdown = (await screen.findByLabelText(
    "Wafer *",
  )) as HTMLSelectElement;
  await waitFor(() => {
    expect(dropdown.options.length).toBe(3);
  });
  await user.selectOptions(dropdown, waferId);
}

function stepIndexInput(): HTMLInputElement {
  return screen.getByLabelText(/Step Index/) as HTMLInputElement;
}

describe("Step index suggestion", () => {
  it("prefills highest existing step_index on the picked wafer plus one", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={fabStepTemplate} />);

    await pickWafer(user, processedWafer.id);

    await waitFor(() => {
      expect(stepIndexInput().value).toBe("6");
    });
  });

  it("suggests 1 for a wafer with no logged steps", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={fabStepTemplate} />);

    await pickWafer(user, bareWafer.id);

    await waitFor(() => {
      expect(stepIndexInput().value).toBe("1");
    });
  });

  it("never overwrites a step index the user already typed", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={fabStepTemplate} />);

    await user.type(stepIndexInput(), "9");
    await pickWafer(user, processedWafer.id);

    // The suggestion resolves asynchronously; give it a chance to land.
    await waitFor(() => {
      expect(apiMocks.getLineageGraph).toHaveBeenCalled();
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stepIndexInput().value).toBe("9");
  });

  it("keeps the wafer and suggests the next index after a create", async () => {
    apiMocks.createEntity.mockImplementation(async () => {
      // The new step now refers to the wafer: its lineage gains step 6.
      apiMocks.getLineageGraph.mockResolvedValue({
        nodes: [
          lineageNode("step-b", "fab_step"),
          lineageNode("step-c", "fab_step"),
        ],
        edges: [],
      });
      apiMocks.getEntity.mockImplementation((_: string, id: string) =>
        Promise.resolve({
          data: entity(id, id, "fab_step", {
            step_index: id === "step-c" ? 6 : 5,
          } as Partial<Entity>),
          etag: '"v0"',
        }),
      );
      return entity("step-c", "STEP-2026-0120", "fab_step");
    });
    const user = userEvent.setup();
    render(<TemplateForm template={fabStepTemplate} />);

    await pickWafer(user, processedWafer.id);
    await waitFor(() => {
      expect(stepIndexInput().value).toBe("6");
    });
    await user.click(screen.getByRole("button", { name: "Create fab step" }));

    await waitFor(() => {
      expect(stepIndexInput().value).toBe("7");
    });
    expect((screen.getByLabelText("Wafer *") as HTMLSelectElement).value).toBe(
      processedWafer.id,
    );
  });

  it("replaces a still-untouched suggestion when the wafer pick changes", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={fabStepTemplate} />);

    await pickWafer(user, processedWafer.id);
    await waitFor(() => {
      expect(stepIndexInput().value).toBe("6");
    });
    await pickWafer(user, bareWafer.id);

    await waitFor(() => {
      expect(stepIndexInput().value).toBe("1");
    });
  });
});

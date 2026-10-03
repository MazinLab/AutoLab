import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Entity,
  type EntityTemplate,
  type EntityType,
  type SearchResult,
} from "../api/client";
import { TemplateForm } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEntity: vi.fn(),
  getEntity: vi.fn(),
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
    created_at: "2026-08-08T10:00:00Z",
    updated_at: "2026-08-08T10:00:00Z",
    version: 0,
    ...overrides,
  };
}

const waferTemplate: EntityTemplate = {
  name: "Wafer",
  batch: true,
  entity_type: "wafer",
  fields: [
    { name: "name", label: "Wafer Name", type: "text", required: true },
  ],
  body: false,
};

const deviceTemplate: EntityTemplate = {
  name: "Device",
  entity_type: "device",
  fields: [
    { name: "name", label: "Device Name", type: "text", required: true },
    { name: "wafer", label: "Source Wafer", type: "entity", required: true },
    { name: "device_type", label: "Device Type", type: "text" },
  ],
  body: false,
};

const agentTemplate: EntityTemplate = {
  name: "Agent",
  entity_type: "agent",
  fields: [
    { name: "name", label: "Agent Name", type: "text", required: true },
    { name: "model", label: "Model", type: "text" },
    { name: "operator", label: "Operator", type: "entity" },
  ],
  body: false,
};

const experimentTemplate: EntityTemplate = {
  name: "Experiment",
  batch: true,
  entity_type: "note",
  fields: [
    { name: "sample", label: "Sample or Device", type: "entity" },
    { name: "name", label: "Log Title", type: "text", required: true },
  ],
  body: true,
};

const sourceWafer = entity("wafer-1", "W-2026-0001", "wafer", {
  name: "W20260808-1",
});
const operator = entity("person-1", "P-2026-0001", "person", {
  name: "Ben Mazin",
});

beforeEach(() => {
  apiMocks.createEntity.mockReset();
  apiMocks.getEntity.mockReset();
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.listEntities.mockReset().mockImplementation(
    (entityType: string) =>
      Promise.resolve(
        entityType === "wafer"
          ? [sourceWafer]
          : entityType === "person"
            ? [operator]
            : [],
      ),
  );
  apiMocks.printLabel.mockReset().mockResolvedValue({
    printer: "bench",
    format: "qr",
  });
  apiMocks.searchEntities.mockReset().mockResolvedValue([]);
});

afterEach(cleanup);

async function openFieldSearch(
  user: ReturnType<typeof userEvent.setup>,
  selectLabel: string | RegExp,
): Promise<void> {
  const field = screen
    .getByLabelText(selectLabel)
    .closest(".entity-field") as HTMLElement;
  await user.click(within(field).getByRole("button", { name: "Search all" }));
}

describe("Batch create", () => {
  it("hides the Copies control on templates without the batch flag", () => {
    render(<TemplateForm template={agentTemplate} />);
    expect(screen.queryByLabelText("Copies")).toBeNull();
  });

  it("creates N records with zero-padded name suffixes and prints each", async () => {
    let serial = 0;
    apiMocks.createEntity.mockImplementation(
      (_type: string, payload: { name: string }) => {
        serial += 1;
        return Promise.resolve(
          entity(`wafer-batch-${serial}`, `W-2026-010${serial}`, "wafer", {
            name: payload.name,
          }),
        );
      },
    );
    apiMocks.getPrinters.mockResolvedValue(["bench"]);
    const onBatchCreated = vi.fn();
    const user = userEvent.setup();
    render(
      <TemplateForm onBatchCreated={onBatchCreated} template={waferTemplate} />,
    );

    await user.type(screen.getByLabelText(/Wafer Name/), "W20260808");
    const copiesInput = screen.getByLabelText("Copies");
    await user.clear(copiesInput);
    await user.type(copiesInput, "3");
    await user.click(screen.getByRole("button", { name: "Create 3 records" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledTimes(3);
    });
    expect(apiMocks.createEntity).toHaveBeenNthCalledWith(1, "wafer", {
      source_key: expect.stringMatching(/^web:/),
      name: "W20260808-01",
    });
    expect(apiMocks.createEntity).toHaveBeenNthCalledWith(2, "wafer", {
      source_key: expect.stringMatching(/^web:/),
      name: "W20260808-02",
    });
    expect(apiMocks.createEntity).toHaveBeenNthCalledWith(3, "wafer", {
      source_key: expect.stringMatching(/^web:/),
      name: "W20260808-03",
    });
    // Each copy is its own logical record with its own idempotency key.
    const sourceKeys = apiMocks.createEntity.mock.calls.map(
      (call) => (call[1] as { source_key: string }).source_key,
    );
    expect(new Set(sourceKeys).size).toBe(3);
    expect(onBatchCreated).toHaveBeenCalledTimes(1);
    expect(onBatchCreated.mock.calls[0][0]).toHaveLength(3);
    await waitFor(() => {
      expect(apiMocks.printLabel).toHaveBeenCalledTimes(3);
    });
  });

  it("replaces the attachment dropzone with a note when Copies > 1", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    expect(screen.getByText("Drop files here, or")).toBeDefined();
    const copiesInput = screen.getByLabelText("Copies");
    await user.clear(copiesInput);
    await user.type(copiesInput, "2");

    expect(screen.queryByText("Drop files here, or")).toBeNull();
    expect(
      screen.getByText(/Attachments are only uploaded for single records/),
    ).toBeDefined();
  });
});

describe("Device and Agent reference rules", () => {
  it("links a device to its source wafer as derived_from and offers a scan", async () => {
    apiMocks.createEntity.mockResolvedValue(
      entity("device-1", "DEV-2026-0001", "device", { name: "C1" }),
    );
    const user = userEvent.setup();
    render(<TemplateForm template={deviceTemplate} />);

    const waferDropdown = (await screen.findByLabelText(
      "Source Wafer *",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(waferDropdown.options.length).toBe(2);
    });
    const waferField = waferDropdown.closest(".entity-field") as HTMLElement;
    expect(
      within(waferField).getByRole("button", { name: "Scan QR label" }),
    ).toBeDefined();

    await user.selectOptions(waferDropdown, sourceWafer.id);
    await user.type(screen.getByLabelText(/Device Name/), "C1");
    await user.type(screen.getByLabelText(/Device Type/), "MKID array");
    await user.click(screen.getByRole("button", { name: "Create device" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("device", {
        source_key: expect.stringMatching(/^web:/),
        name: "C1",
        device_type: "MKID array",
        links: [{ relation: "derived_from", dst_id: sourceWafer.id }],
      });
    });
  });

  it("stores the agent's operator as the operator_id column, not an edge", async () => {
    apiMocks.createEntity.mockResolvedValue(
      entity("agent-1", "AG-2026-0001", "agent", { name: "labbot" }),
    );
    const user = userEvent.setup();
    render(<TemplateForm template={agentTemplate} />);

    const operatorDropdown = (await screen.findByLabelText(
      "Operator",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(operatorDropdown.options.length).toBe(2);
    });
    await user.selectOptions(operatorDropdown, operator.id);
    await user.type(screen.getByLabelText(/Agent Name/), "labbot");
    await user.type(screen.getByLabelText(/Model/), "claude-fable-5");
    await user.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("agent", {
        source_key: expect.stringMatching(/^web:/),
        name: "labbot",
        model: "claude-fable-5",
        operator_id: operator.id,
      });
    });
  });
});

describe("Reference picker type-ahead search", () => {
  it("searches on typing, filters to the field's target types, and links the pick", async () => {
    const deviceHit: SearchResult = {
      id: "device-417",
      entity_type: "device",
      accession: "DEV-2026-0417",
      name: "Array 417",
    };
    const softwareHit: SearchResult = {
      id: "software-1",
      entity_type: "software",
      accession: "SW-2026-0001",
      name: "Array pipeline",
    };
    apiMocks.searchEntities.mockResolvedValue([deviceHit, softwareHit]);
    // A search pick fetches the full record so semantic filters and autofill
    // can run against real field data.
    apiMocks.getEntity.mockResolvedValue({
      data: entity(deviceHit.id, deviceHit.accession, "device", {
        name: deviceHit.name,
      }),
      etag: '"v0"',
    });
    apiMocks.createEntity.mockResolvedValue(
      entity("note-1", "N-2026-0001", "note", { name: "Cooldown 19" }),
    );
    const user = userEvent.setup();
    render(<TemplateForm template={experimentTemplate} />);

    await screen.findByLabelText("Sample or Device");
    await openFieldSearch(user, "Sample or Device");
    await user.type(screen.getByLabelText("Search Sample or Device"), "Array");

    await waitFor(() => {
      expect(apiMocks.searchEntities).toHaveBeenCalledWith("Array", 25);
    });
    const dropdown = screen.getByLabelText(
      "Sample or Device",
    ) as HTMLSelectElement;
    await waitFor(() => {
      expect(dropdown.options[1]?.textContent).toContain(deviceHit.name);
    });
    // Placeholder plus the device hit; the software hit is not a valid
    // target type for this field and is filtered out.
    expect(dropdown.options.length).toBe(2);

    await user.selectOptions(dropdown, deviceHit.id);
    await user.type(screen.getByLabelText(/Log Title/), "Cooldown 19");
    await user.click(screen.getByRole("button", { name: "Create experiment" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("note", {
        source_key: expect.stringMatching(/^web:/),
        name: "Cooldown 19",
        body: "",
        template: "Experiment",
        links: [{ relation: "refers_to", dst_id: deviceHit.id }],
      });
    });
  });
});

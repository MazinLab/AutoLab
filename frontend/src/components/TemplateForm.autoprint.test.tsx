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
  getPrinters: vi.fn(),
  listEntities: vi.fn(),
  printLabel: vi.fn(),
  uploadArtifact: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    listEntities: apiMocks.listEntities,
    printLabel: apiMocks.printLabel,
    uploadArtifact: apiMocks.uploadArtifact,
  };
});

function entity(id: string, accession: string, entityType: EntityType): Entity {
  return {
    id,
    accession,
    entity_type: entityType,
    name: accession,
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-08-23T10:00:00Z",
    updated_at: "2026-08-23T10:00:00Z",
    version: 0,
  };
}

function template(
  name: string,
  entityType: EntityType,
  batch = false,
): EntityTemplate {
  return {
    name,
    entity_type: entityType,
    fields: [{ name: "name", label: "Name", type: "text", required: true }],
    body: false,
    batch,
  };
}

const waferTemplate = template("Wafer", "wafer", true);
const deviceTemplate = template("Device", "device");
const noteTemplate = template("Fab Note", "note");
const batchTemplate = template("Substrate Batch", "substrate_batch");

beforeEach(() => {
  apiMocks.getPrinters.mockReset().mockResolvedValue(["zebra"]);
  apiMocks.printLabel.mockReset().mockResolvedValue({
    printer: "zebra",
    format: "qr",
  });
  apiMocks.listEntities.mockReset().mockResolvedValue([]);
  apiMocks.uploadArtifact.mockReset();
  apiMocks.createEntity.mockReset();
});

afterEach(cleanup);

async function createOne(
  form: EntityTemplate,
  created: Entity,
  submitLabel: string,
): Promise<void> {
  apiMocks.createEntity.mockResolvedValue(created);
  const user = userEvent.setup();
  render(<TemplateForm template={form} />);
  await user.type(screen.getByLabelText(/Name/), created.accession);
  await user.click(screen.getByRole("button", { name: submitLabel }));
  await waitFor(() => {
    expect(apiMocks.createEntity).toHaveBeenCalled();
  });
}

describe("automatic label printing on create", () => {
  it("prints a label for a new wafer", async () => {
    const wafer = entity("w-1", "W-2026-0007", "wafer");

    await createOne(waferTemplate, wafer, "Create wafer");

    await waitFor(() => {
      expect(apiMocks.printLabel).toHaveBeenCalledWith(wafer.id);
    });
  });

  it("prints a label for a new substrate batch", async () => {
    const sub = entity("s-1", "SUB-2026-0003", "substrate_batch");

    await createOne(batchTemplate, sub, "Create substrate batch");

    await waitFor(() => {
      expect(apiMocks.printLabel).toHaveBeenCalledWith(sub.id);
    });
  });

  it("prints one label per copy in a batch create", async () => {
    const wafers = [
      entity("w-1", "W-2026-0008", "wafer"),
      entity("w-2", "W-2026-0009", "wafer"),
      entity("w-3", "W-2026-0010", "wafer"),
    ];
    // Copies are suffixed -01, -02, -03 by the form.
    apiMocks.createEntity.mockImplementation(async (_type, payload) => {
      const suffix = String((payload as { name?: string }).name ?? "").slice(
        -2,
      );
      return wafers[Number(suffix) - 1];
    });
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);
    const copies = screen.getByLabelText("Copies");
    await user.clear(copies);
    await user.type(copies, "3");
    await user.type(screen.getByLabelText(/Name/), "W");
    await user.click(screen.getByRole("button", { name: "Create 3 records" }));

    await waitFor(() => {
      expect(apiMocks.printLabel).toHaveBeenCalledTimes(3);
    });
    expect(
      apiMocks.printLabel.mock.calls.map((call) => call[0]).sort(),
    ).toEqual(["w-1", "w-2", "w-3"]);
  });

  it("does not print for a device: the label does not fit the box", async () => {
    const device = entity("d-1", "DEV-2026-0004", "device");

    await createOne(deviceTemplate, device, "Create device");

    // Deliberate — devices are printed on demand from the entity page.
    expect(apiMocks.printLabel).not.toHaveBeenCalled();
  });

  it("does not print for records with nothing physical to label", async () => {
    const note = entity("n-1", "NOTE-2026-0002", "note");

    await createOne(noteTemplate, note, "Create fab note");

    expect(apiMocks.printLabel).not.toHaveBeenCalled();
  });

  it("stays quiet when no printer is configured", async () => {
    apiMocks.getPrinters.mockResolvedValue([]);
    const wafer = entity("w-9", "W-2026-0011", "wafer");

    await createOne(waferTemplate, wafer, "Create wafer");

    await waitFor(() => {
      expect(apiMocks.getPrinters).toHaveBeenCalled();
    });
    expect(apiMocks.printLabel).not.toHaveBeenCalled();
    expect(screen.queryByText(/label failed/)).toBeNull();
  });

  it("surfaces a failed label without losing the created record", async () => {
    apiMocks.printLabel.mockRejectedValue(new Error("printer offline"));
    const wafer = entity("w-8", "W-2026-0012", "wafer");

    await createOne(waferTemplate, wafer, "Create wafer");

    expect(
      await screen.findByText(/label failed — reprint from the entity page/),
    ).toBeDefined();
    // The record itself was created exactly once.
    expect(apiMocks.createEntity).toHaveBeenCalledTimes(1);
  });
});

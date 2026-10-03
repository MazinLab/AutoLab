import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type Entity, type EntityTemplate } from "../api/client";
import { TemplateForm } from "./TemplateForm";

const apiMocks = vi.hoisted(() => ({
  createEdge: vi.fn(),
  createEntity: vi.fn(),
  getPrinters: vi.fn(),
  listEntities: vi.fn(),
  resolveAccession: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    createEdge: apiMocks.createEdge,
    createEntity: apiMocks.createEntity,
    getPrinters: apiMocks.getPrinters,
    listEntities: apiMocks.listEntities,
    resolveAccession: apiMocks.resolveAccession,
  };
});

const waferTemplate: EntityTemplate = {
  name: "Wafer",
  entity_type: "wafer",
  group: "fab",
  fields: [
    { name: "name", label: "Wafer Name", type: "text", required: true },
    { name: "substrate", label: "Substrate Batch", type: "entity" },
    { name: "design", label: "Design", type: "entity" },
    { name: "diameter_mm", label: "Diameter", type: "number", unit: "mm" },
  ],
  body: false,
};

function entity(overrides: Partial<Entity>): Entity {
  return {
    id: "01900000-0000-7000-8000-000000000090",
    accession: "SUB-2026-0001",
    entity_type: "substrate_batch",
    name: "UniversityWafer lot A3",
    description: "",
    extra: {},
    source_key: null,
    created_by_id: null,
    created_at: "2026-07-20T10:00:00Z",
    updated_at: "2026-07-20T10:00:00Z",
    version: 0,
    ...overrides,
  };
}

const batch = entity({
  vendor: "UniversityWafer",
  material: "Si",
  diameter_mm: 100,
  thickness_um: 350,
});

const createdWafer = entity({
  id: "01900000-0000-7000-8000-000000000091",
  accession: "W-2026-0010",
  entity_type: "wafer",
  name: "W20260720-2",
});

beforeEach(() => {
  apiMocks.createEdge.mockReset().mockResolvedValue({});
  apiMocks.createEntity.mockReset().mockResolvedValue(createdWafer);
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.listEntities.mockReset().mockImplementation(
    (entityType: string) =>
      Promise.resolve(entityType === "substrate_batch" ? [batch] : []),
  );
  apiMocks.resolveAccession.mockReset();
});

afterEach(cleanup);

describe("Wafer substrate batch autofill", () => {
  it("autofills diameter and carries material when a batch is picked", async () => {
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    const dropdown = (await screen.findByLabelText(
      "Substrate Batch",
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(dropdown.options.length).toBe(2);
    });
    await user.selectOptions(dropdown, batch.id);

    const diameter = screen.getByLabelText(/Diameter/) as HTMLInputElement;
    expect(diameter.value).toBe("100");

    await user.type(screen.getByLabelText(/Wafer Name/), "W20260720-2");
    await user.click(screen.getByRole("button", { name: "Create wafer" }));

    await waitFor(() => {
      expect(apiMocks.createEntity).toHaveBeenCalledWith("wafer", {
        source_key: expect.stringMatching(/^web:/),
        name: "W20260720-2",
        material: "Si",
        diameter_mm: 100,
        links: [{ relation: "refers_to", dst_id: batch.id }],
      });
    });
    expect(apiMocks.createEdge).not.toHaveBeenCalled();
  });

  it("resolves a scanned accession into the batch selection", async () => {
    apiMocks.resolveAccession.mockResolvedValue({ data: batch, etag: '"v0"' });
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    // Every entity field offers a scan button; scope to the substrate field.
    const substrateField = (
      await screen.findByLabelText("Substrate Batch")
    ).closest(".entity-field") as HTMLElement;
    await user.click(
      within(substrateField).getByRole("button", { name: "Scan QR label" }),
    );
    // Camera is unavailable in tests; the scanner's manual entry path is the
    // same resolution flow.
    await user.type(screen.getByLabelText("Accession"), "SUB-2026-0001");
    await user.click(screen.getByRole("button", { name: "Use" }));

    await waitFor(() => {
      expect(apiMocks.resolveAccession).toHaveBeenCalledWith("SUB-2026-0001");
    });
    const dropdown = screen.getByLabelText(
      "Substrate Batch",
    ) as HTMLSelectElement;
    expect(dropdown.value).toBe(batch.id);
    expect(
      (screen.getByLabelText(/Diameter/) as HTMLInputElement).value,
    ).toBe("100");
  });

  it("rejects a scanned code of the wrong entity type", async () => {
    apiMocks.resolveAccession.mockResolvedValue({
      data: entity({
        accession: "DEV-2026-0001",
        entity_type: "device",
        name: "C1",
      }),
      etag: '"v0"',
    });
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    const substrateField = (
      await screen.findByLabelText("Substrate Batch")
    ).closest(".entity-field") as HTMLElement;
    await user.click(
      within(substrateField).getByRole("button", { name: "Scan QR label" }),
    );
    await user.type(screen.getByLabelText("Accession"), "DEV-2026-0001");
    await user.click(screen.getByRole("button", { name: "Use" }));

    expect(
      await screen.findByText(/is a device; expected substrate batch/),
    ).toBeDefined();
  });
});

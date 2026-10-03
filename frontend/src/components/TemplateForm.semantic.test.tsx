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
  resolveAccession: vi.fn(),
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
    resolveAccession: apiMocks.resolveAccession,
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

const cooldownTemplate: EntityTemplate = {
  name: "Experiment Setup",
  entity_type: "experiment_setup",
  fields: [
    { name: "instrument", label: "Instrument", type: "entity", required: true },
  ],
  body: false,
};

const waferTemplate: EntityTemplate = {
  name: "Wafer",
  entity_type: "wafer",
  fields: [
    { name: "name", label: "Wafer Name", type: "text", required: true },
    { name: "substrate", label: "Substrate Batch", type: "entity" },
    { name: "diameter_mm", label: "Diameter", type: "number", unit: "mm" },
  ],
  body: false,
};

const sputter = entity("instrument-2", "INST-2026-0002", "instrument", {
  name: "AJA Sputter",
  category: "fab",
});
const fridge = entity("instrument-1", "INST-2026-0001", "instrument", {
  name: "White Fridge",
  category: "testbed",
});
const batch = entity("batch-1", "SUB-2026-0001", "substrate_batch", {
  name: "UniversityWafer lot A3",
  material: "Si",
  diameter_mm: 100,
});

function searchHit(record: Entity): SearchResult {
  return {
    id: record.id,
    entity_type: record.entity_type,
    accession: record.accession,
    name: record.name,
  };
}

beforeEach(() => {
  apiMocks.createEntity.mockReset();
  apiMocks.getEntity.mockReset();
  apiMocks.getPrinters.mockReset().mockResolvedValue([]);
  apiMocks.listEntities.mockReset().mockResolvedValue([]);
  apiMocks.resolveAccession.mockReset();
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

describe("Semantic where filters on type-ahead picks", () => {
  it("rejects a search pick whose category violates the field's rule", async () => {
    // Search returns only the id/name summary; the full record reveals the
    // fab category that the testbed field must reject.
    apiMocks.searchEntities.mockResolvedValue([searchHit(sputter)]);
    apiMocks.getEntity.mockResolvedValue({ data: sputter, etag: '"v0"' });
    const user = userEvent.setup();
    render(<TemplateForm template={cooldownTemplate} />);

    await screen.findByLabelText("Instrument *");
    await openFieldSearch(user, "Instrument *");
    await user.type(screen.getByLabelText("Search Instrument"), "AJA");
    const dropdown = screen.getByLabelText("Instrument *") as HTMLSelectElement;
    await waitFor(() => {
      expect(dropdown.options.length).toBe(2);
    });
    await user.selectOptions(dropdown, sputter.id);

    expect(
      await screen.findByText(
        "INST-2026-0002 has category fab; expected testbed.",
      ),
    ).toBeDefined();
    // The invalid pick was not kept.
    expect(dropdown.value).toBe("");
    expect(apiMocks.getEntity).toHaveBeenCalledWith(
      "instrument",
      sputter.id,
    );
  });

  it("accepts a valid search pick after fetching and caching the record", async () => {
    apiMocks.searchEntities.mockResolvedValue([searchHit(fridge)]);
    apiMocks.getEntity.mockResolvedValue({ data: fridge, etag: '"v0"' });
    const user = userEvent.setup();
    render(<TemplateForm template={cooldownTemplate} />);

    await screen.findByLabelText("Instrument *");
    await openFieldSearch(user, "Instrument *");
    await user.type(screen.getByLabelText("Search Instrument"), "Fridge");
    const dropdown = screen.getByLabelText("Instrument *") as HTMLSelectElement;
    await waitFor(() => {
      expect(dropdown.options.length).toBe(2);
    });
    await user.selectOptions(dropdown, fridge.id);
    await waitFor(() => {
      expect(dropdown.value).toBe(fridge.id);
    });

    // Re-picking the same entity reuses the cached fetch.
    await user.selectOptions(dropdown, "");
    await user.selectOptions(dropdown, fridge.id);
    await waitFor(() => {
      expect(dropdown.value).toBe(fridge.id);
    });
    expect(apiMocks.getEntity).toHaveBeenCalledTimes(1);
  });

  it("runs the rule's autofill from the fetched record on a search pick", async () => {
    apiMocks.searchEntities.mockResolvedValue([searchHit(batch)]);
    apiMocks.getEntity.mockResolvedValue({ data: batch, etag: '"v0"' });
    const user = userEvent.setup();
    render(<TemplateForm template={waferTemplate} />);

    await screen.findByLabelText("Substrate Batch");
    await openFieldSearch(user, "Substrate Batch");
    await user.type(
      screen.getByLabelText("Search Substrate Batch"),
      "UniversityWafer",
    );
    const dropdown = screen.getByLabelText(
      "Substrate Batch",
    ) as HTMLSelectElement;
    await waitFor(() => {
      expect(dropdown.options.length).toBe(2);
    });
    await user.selectOptions(dropdown, batch.id);

    // The search summary has no diameter; the autofill came from the full
    // fetched record.
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/Diameter/) as HTMLInputElement).value,
      ).toBe("100");
    });
  });
});

describe("Semantic where filters on scan picks", () => {
  it("rejects a scanned entity whose category violates the field's rule", async () => {
    apiMocks.resolveAccession.mockResolvedValue({ data: sputter, etag: '"v0"' });
    const user = userEvent.setup();
    render(<TemplateForm template={cooldownTemplate} />);

    const field = (await screen.findByLabelText("Instrument *")).closest(
      ".entity-field",
    ) as HTMLElement;
    await user.click(
      within(field).getByRole("button", { name: "Scan QR label" }),
    );
    await user.type(screen.getByLabelText("Accession"), "INST-2026-0002");
    await user.click(screen.getByRole("button", { name: "Use" }));

    expect(
      await screen.findByText(
        "INST-2026-0002 has category fab; expected testbed.",
      ),
    ).toBeDefined();
    expect(
      (screen.getByLabelText("Instrument *") as HTMLSelectElement).value,
    ).toBe("");
  });

  it("accepts a scanned entity that satisfies the rule", async () => {
    apiMocks.resolveAccession.mockResolvedValue({ data: fridge, etag: '"v0"' });
    const user = userEvent.setup();
    render(<TemplateForm template={cooldownTemplate} />);

    const field = (await screen.findByLabelText("Instrument *")).closest(
      ".entity-field",
    ) as HTMLElement;
    await user.click(
      within(field).getByRole("button", { name: "Scan QR label" }),
    );
    await user.type(screen.getByLabelText("Accession"), "INST-2026-0001");
    await user.click(screen.getByRole("button", { name: "Use" }));

    await waitFor(() => {
      expect(
        (screen.getByLabelText("Instrument *") as HTMLSelectElement).value,
      ).toBe(fridge.id);
    });
  });
});

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getEntity,
  getEntityEvents,
  getEntityLabel,
  getFabFlow,
  getLineageGraph,
  getPrinters,
  getRegistry,
  type Entity,
  type FabFlowStep,
} from "../api/client";
import { EntityPage } from "./entity/EntityPage";

vi.mock("../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getEntity: vi.fn(),
    getEntityEvents: vi.fn(),
    getEntityLabel: vi.fn(),
    getFabFlow: vi.fn(),
    getLineageGraph: vi.fn(),
    getPrinters: vi.fn(),
    getRegistry: vi.fn(),
  };
});

const wafer: Entity = {
  id: "01900000-0000-7000-8000-000000000001",
  accession: "W-2026-0001",
  entity_type: "wafer",
  name: "W20260812-1",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-08-01T20:00:00Z",
  updated_at: "2026-08-01T20:00:00Z",
  version: 1,
};

const steps: FabFlowStep[] = [
  {
    id: "01900000-0000-7000-8000-000000000101",
    accession: "STEP-2026-0001",
    step_index: 1,
    name: "",
    body: "",
    created_at: "2026-08-02T18:00:00Z",
    recipe: {
      id: "01900000-0000-7000-8000-000000000201",
      entity_type: "fab_recipe",
      accession: "RCP-2026-0001",
      name: "Hf sputter",
    },
    instrument: {
      id: "01900000-0000-7000-8000-000000000301",
      entity_type: "instrument",
      accession: "INST-2026-0001",
      name: "AJA Sputter",
    },
  },
  {
    id: "01900000-0000-7000-8000-000000000102",
    accession: "STEP-2026-0003",
    step_index: 2,
    name: "",
    body: "Ran 36 s instead of 30 s",
    created_at: "2026-08-03T18:00:00Z",
    recipe: {
      id: "01900000-0000-7000-8000-000000000202",
      entity_type: "fab_recipe",
      accession: "RCP-2026-0002",
      name: "BCl3 etch",
    },
    instrument: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRegistry).mockResolvedValue({
    id: wafer.id,
    entity_type: wafer.entity_type,
    accession: wafer.accession,
    source_key: null,
    version: 1,
    created_at: wafer.created_at,
    updated_at: wafer.updated_at,
    created_by_id: null,
  });
  vi.mocked(getEntity).mockResolvedValue({ data: wafer, etag: '"v1"' });
  vi.mocked(getEntityEvents).mockResolvedValue({
    events: [],
    next_cursor: null,
  });
  vi.mocked(getEntityLabel).mockResolvedValue("W20260812-1");
  vi.mocked(getPrinters).mockResolvedValue([]);
  vi.mocked(getLineageGraph).mockResolvedValue({ nodes: [], edges: [] });
  vi.mocked(getFabFlow).mockResolvedValue(steps);
});

afterEach(cleanup);

function renderWafer() {
  return render(
    <MemoryRouter initialEntries={[`/entity/${wafer.id}`]}>
      <Routes>
        <Route path="/entity/:id" element={<EntityPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("wafer fab flow", () => {
  it("lists the steps in order with their recipe, machine, and notes", async () => {
    renderWafer();

    const flow = await screen.findByRole("list", { name: "Fab flow" });
    const items = within(flow).getAllByRole("listitem");
    expect(items).toHaveLength(2);

    // The recipe name is the headline; the step's own accession stays quiet.
    expect(
      within(items[0]).getByRole("link", { name: /Hf sputter/ }),
    ).toHaveProperty("href", expect.stringContaining(steps[0].id));
    expect(items[0].textContent).toContain("AJA Sputter");
    expect(items[0].textContent).toContain("STEP-2026-0001");

    expect(
      within(items[1]).getByRole("link", { name: /BCl3 etch/ }),
    ).toBeDefined();
    expect(items[1].textContent).toContain("Ran 36 s instead of 30 s");

    // Each step links through to the recipe it ran.
    expect(
      within(items[0]).getByRole("link", { name: "Recipe" }),
    ).toHaveProperty("href", expect.stringContaining(steps[0].recipe!.id));
  });

  it("keeps flow steps out of Related records", async () => {
    vi.mocked(getLineageGraph).mockImplementation(async (_id, query) =>
      query?.direction === "both"
        ? {
            nodes: [
              {
                id: steps[0].id,
                accession: steps[0].accession,
                entity_type: "fab_step",
                depth: 1,
                name: "",
              },
              {
                id: "01900000-0000-7000-8000-000000000401",
                accession: "SUB-2026-0001",
                entity_type: "substrate_batch",
                depth: 1,
                name: "DSP Sapphire Lot 772511",
              },
            ],
            edges: [],
          }
        : { nodes: [], edges: [] },
    );

    renderWafer();

    const related = await screen.findByRole("list", {
      name: "Related records",
    });
    await waitFor(() => {
      expect(within(related).getAllByRole("listitem")).toHaveLength(1);
    });
    // The substrate batch survives; the fab step lives in the flow instead.
    expect(related.textContent).toContain("DSP Sapphire Lot 772511");
    expect(related.textContent).not.toContain("STEP-2026-0001");
  });

  it("shows an empty state for a wafer with no steps", async () => {
    vi.mocked(getFabFlow).mockResolvedValue([]);

    renderWafer();

    expect(await screen.findByText(/No fab steps recorded yet/)).toBeDefined();
  });

  it("does not query the fab flow for non-wafer records", async () => {
    const recipe: Entity = {
      ...wafer,
      id: "01900000-0000-7000-8000-000000000201",
      accession: "RCP-2026-0001",
      entity_type: "fab_recipe",
      name: "Hf sputter",
    };
    vi.mocked(getRegistry).mockResolvedValue({
      id: recipe.id,
      entity_type: recipe.entity_type,
      accession: recipe.accession,
      source_key: null,
      version: 1,
      created_at: recipe.created_at,
      updated_at: recipe.updated_at,
      created_by_id: null,
    });
    vi.mocked(getEntity).mockResolvedValue({ data: recipe, etag: '"v1"' });

    render(
      <MemoryRouter initialEntries={[`/entity/${recipe.id}`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { name: "Related records" });
    expect(getFabFlow).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Fab flow" })).toBeNull();
  });
});

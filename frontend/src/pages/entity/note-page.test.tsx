import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getEntity,
  getEntityEvents,
  getEntityLabel,
  getLineageGraph,
  getPrinters,
  getRegistry,
  getTemplates,
  type Entity,
} from "../../api/client";
import { detailEntries, EntityPage } from "./EntityPage";

vi.mock("../../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/client")>(
      "../../api/client",
    );
  return {
    ...actual,
    getEntity: vi.fn(),
    getEntityEvents: vi.fn(),
    getEntityLabel: vi.fn(),
    getLineageGraph: vi.fn(),
    getPrinters: vi.fn(),
    getRegistry: vi.fn(),
    getTemplates: vi.fn(),
  };
});

const experimentNote: Entity = {
  id: "01900000-0000-7000-8000-000000000030",
  accession: "NOTE-2026-0011",
  entity_type: "note",
  name: "New test",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-20T21:00:00Z",
  updated_at: "2026-07-20T21:00:00Z",
  version: 0,
  body: "## Setup\nBias at **-78 dBm**.",
  template: "Experiment",
};

const linkedDevice: Entity = {
  ...experimentNote,
  id: "01900000-0000-7000-8000-000000000031",
  accession: "DEV-2026-0001",
  entity_type: "device",
  name: "C1",
  body: undefined,
  template: undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRegistry).mockResolvedValue({
    id: experimentNote.id,
    entity_type: "note",
    accession: experimentNote.accession,
    source_key: null,
    version: 0,
    created_at: experimentNote.created_at,
    updated_at: experimentNote.updated_at,
    created_by_id: null,
  });
  vi.mocked(getEntity).mockImplementation(async (entityType) => ({
    data: entityType === "device" ? linkedDevice : experimentNote,
    etag: '"v0"',
  }));
  vi.mocked(getEntityEvents).mockResolvedValue({
    events: [],
    next_cursor: null,
  });
  vi.mocked(getEntityLabel).mockResolvedValue("");
  vi.mocked(getPrinters).mockResolvedValue([]);
  vi.mocked(getTemplates).mockResolvedValue([
    { name: "Experiment", entity_type: "note", fields: [], body: true },
  ]);
  // Hydrated response: node names ride along, so the page needs no per-node
  // getEntity fetch for the linked device.
  vi.mocked(getLineageGraph).mockImplementation(async (_entityId, query) => ({
    nodes:
      query?.direction === "both" && query.relations?.includes("refers_to")
        ? [
            {
              id: linkedDevice.id,
              accession: linkedDevice.accession,
              entity_type: "device" as const,
              depth: 1,
              name: linkedDevice.name,
            },
          ]
        : [],
    edges: [],
  }));
});

afterEach(cleanup);

describe("detailEntries", () => {
  it("keeps scalar typed and extra fields, hides bookkeeping and ids", () => {
    const batch: Entity = {
      ...experimentNote,
      entity_type: "substrate_batch",
      body: undefined,
      template: undefined,
      vendor: "UniversityWafer",
      material: "Si",
      diameter_mm: 100,
      thickness_um: 350,
      resistivity: "",
      fab_run_id: "01900000-0000-7000-8000-00000000dead",
      extra: { po_number: "PO-4471" },
    };
    const entries = Object.fromEntries(detailEntries(batch));

    expect(entries.vendor).toBe("UniversityWafer");
    expect(entries.material).toBe("Si");
    expect(entries.diameter_mm).toBe("100");
    expect(entries.thickness_um).toBe("350");
    expect(entries.po_number).toBe("PO-4471");
    expect(entries).not.toHaveProperty("resistivity");
    expect(entries).not.toHaveProperty("fab_run_id");
    expect(entries).not.toHaveProperty("accession");
    expect(entries).not.toHaveProperty("version");
  });
});

describe("EntityPage for a note", () => {
  it("renders the note's own markdown body and links non-note related records", async () => {
    render(
      <MemoryRouter initialEntries={[`/entity/${experimentNote.id}`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    // The log body is the page's main content, rendered as markdown.
    expect(
      await screen.findByRole("heading", { level: 2, name: "Setup" }),
    ).toBeDefined();
    expect(screen.getByText("-78 dBm").tagName).toBe("STRONG");
    expect(screen.getByText("Experiment")).toBeDefined();

    // The device the experiment refers_to appears as a linked record, not
    // just a raw UUID in the event feed.
    const deviceLink = await screen.findByRole("link", {
      name: /DEV-2026-0001/,
    });
    expect(deviceLink.getAttribute("href")).toBe(`/entity/${linkedDevice.id}`);
    expect(deviceLink.textContent).toContain("C1");

    // The device's name came from the hydrated lineage nodes: the only full
    // entity fetch was the note itself — no per-node fan-out.
    expect(vi.mocked(getEntity)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getEntity)).toHaveBeenCalledWith(
      "note",
      experimentNote.id,
    );
    for (const call of vi.mocked(getLineageGraph).mock.calls) {
      expect(call[1]).toMatchObject({ hydrate: true });
    }
  });

  it("hides the Notebook list: the note's body is its log", async () => {
    render(
      <MemoryRouter initialEntries={[`/entity/${experimentNote.id}`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { level: 2, name: "Log" });
    expect(
      screen.queryByRole("heading", { level: 2, name: "Notes" }),
    ).toBeNull();
    expect(screen.queryByRole("link", { name: "+ New note" })).toBeNull();
  });

  it("links Clone and Supersede when a template matches the note's template", async () => {
    render(
      <MemoryRouter initialEntries={[`/entity/${experimentNote.id}`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    const clone = await screen.findByRole("link", { name: "Clone" });
    expect(clone.getAttribute("href")).toBe(`/new?from=${experimentNote.id}`);
    const supersede = screen.getByRole("link", { name: "Supersede" });
    expect(supersede.getAttribute("href")).toBe(
      `/new?supersede=${experimentNote.id}`,
    );
  });

  it("hides Clone and Supersede when no template matches", async () => {
    vi.mocked(getTemplates).mockResolvedValue([
      { name: "Wafer", entity_type: "wafer", fields: [], body: false },
    ]);
    render(
      <MemoryRouter initialEntries={[`/entity/${experimentNote.id}`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    await screen.findByRole("heading", { level: 2, name: "Setup" });
    expect(screen.queryByRole("link", { name: "Clone" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Supersede" })).toBeNull();
  });
});

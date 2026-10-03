import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ApiError,
  getEntity,
  getEntityEvents,
  getEntityLabel,
  getFabFlow,
  getLineageGraph,
  getPrinters,
  getRegistry,
  getResultSummaryTable,
  getWhoami,
  resolveAccession,
  type Entity,
  type LineageGraph,
} from "../api/client";
import {
  layoutLineageGraph,
  LineageGraph as LineageGraphView,
} from "../components/LineageGraph";
import { AccessionResolverPage } from "./browse/AccessionResolverPage";
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
    getResultSummaryTable: vi.fn(),
    getWhoami: vi.fn(),
    resolveAccession: vi.fn(),
  };
});

const wafer: Entity = {
  id: "01900000-0000-7000-8000-000000000001",
  accession: "W-2026-0001",
  entity_type: "wafer",
  name: "Science wafer",
  description: "A production detector wafer",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 1,
};

const artifact: Entity = {
  ...wafer,
  id: "01900000-0000-7000-8000-000000000002",
  accession: "ART-2026-0001",
  entity_type: "artifact",
  name: "Wafer map",
  description: "Optical inspection image",
  media_type: "image/png",
  data_format: "png",
  size_bytes: 2048,
};

const note: Entity = {
  ...wafer,
  id: "01900000-0000-7000-8000-000000000003",
  accession: "NOTE-2026-0001",
  entity_type: "note",
  name: "Inspection note",
  description: "",
  body: "The wafer map was reviewed.",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getEntityEvents)
    .mockResolvedValueOnce({
      events: [
        {
          id: "event-1",
          at: "2026-07-18T20:00:00Z",
          actor_id: null,
          action: "created",
          entity_id: wafer.id,
          payload: { entity_type: "wafer" },
        },
      ],
      next_cursor: "2026-07-18T20:00:00Z|event-1",
    })
    .mockResolvedValueOnce({
      events: [
        {
          id: "event-3",
          at: "2026-07-18T20:01:00Z",
          actor_id: null,
          action: "updated",
          entity_id: wafer.id,
          payload: { fields: ["description"] },
        },
      ],
      next_cursor: null,
    });
  vi.mocked(getLineageGraph).mockImplementation(async (_entityId, query) =>
    query?.direction === "both"
      ? {
          nodes: [
            {
              id: artifact.id,
              accession: artifact.accession,
              entity_type: "artifact",
              depth: 1,
            },
            {
              id: note.id,
              accession: note.accession,
              entity_type: "note",
              depth: 1,
            },
          ],
          edges: [],
        }
      : { nodes: [], edges: [] },
  );
  vi.mocked(getFabFlow).mockResolvedValue([]);
  vi.mocked(getEntityLabel).mockResolvedValue("Science.Wafer");
  vi.mocked(getPrinters).mockResolvedValue([]);
  vi.mocked(getEntity).mockImplementation(async (entityType) => ({
    data:
      entityType === "artifact"
        ? artifact
        : entityType === "note"
          ? note
          : wafer,
    etag: '"v1"',
  }));
  vi.mocked(getRegistry).mockResolvedValue({
    id: wafer.id,
    entity_type: wafer.entity_type,
    accession: wafer.accession,
    source_key: wafer.source_key,
    version: wafer.version,
    created_at: wafer.created_at,
    updated_at: wafer.updated_at,
    created_by_id: wafer.created_by_id,
  });
  vi.mocked(resolveAccession).mockResolvedValue({ data: wafer, etag: '"v1"' });
  vi.mocked(getWhoami).mockResolvedValue({ login: "x", person: null, mapped: false, can_write: true });
});

afterEach(() => {
  cleanup();
});

function LocationProbe() {
  const location = useLocation();
  return <p>{`${location.pathname}${location.search}`}</p>;
}

describe("LineageGraph", () => {
  it("assigns one x column per traversal depth and renders cross-links", () => {
    const graph: LineageGraph = {
      nodes: [
        { id: "up-a", accession: "W-1", entity_type: "wafer", depth: -1 },
        { id: "up-b", accession: "W-2", entity_type: "wafer", depth: -1 },
        { id: "root", accession: "D-1", entity_type: "device", depth: 0 },
        {
          id: "down",
          accession: "CD-1",
          entity_type: "experiment_setup",
          depth: 2,
        },
      ],
      edges: [
        { src_id: "root", dst_id: "up-a", relation: "derived_from" },
        { src_id: "down", dst_id: "up-b", relation: "part_of" },
      ],
    };
    const layout = layoutLineageGraph(graph.nodes);
    const positions = new Map(layout.nodes.map((node) => [node.id, node]));
    expect(positions.get("up-a")?.x).toBe(positions.get("up-b")?.x);
    expect(positions.get("up-a")?.x).toBeLessThan(
      positions.get("root")?.x ?? 0,
    );
    expect(positions.get("down")?.x).toBeGreaterThan(
      positions.get("root")?.x ?? 0,
    );

    const { container } = render(
      <MemoryRouter>
        <LineageGraphView focusId="root" graph={graph} />
      </MemoryRouter>,
    );
    expect(container.querySelectorAll(".lineage-edge-label")).toHaveLength(2);
    expect(
      container
        .querySelector('[data-node-id="root"]')
        ?.getAttribute("data-depth"),
    ).toBe("0");
  });
});

describe("AccessionResolverPage", () => {
  it("resolves an accession and redirects with entity type context", async () => {
    render(
      <MemoryRouter initialEntries={[`/e/${wafer.accession}`]}>
        <Routes>
          <Route path="/e/:accession" element={<AccessionResolverPage />} />
          <Route path="/entity/:id" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(resolveAccession).toHaveBeenCalledWith(wafer.accession),
    );
    expect(await screen.findByText(`/entity/${wafer.id}`)).toBeTruthy();
  });

  it("shows a not-found state for an unknown accession", async () => {
    vi.mocked(resolveAccession).mockRejectedValue(
      new ApiError(404, "no entity with this accession"),
    );
    render(
      <MemoryRouter initialEntries={["/e/UNKNOWN"]}>
        <Routes>
          <Route path="/e/:accession" element={<AccessionResolverPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Record not found" }),
    ).toBeTruthy();
  });
});

describe("EntityPage", () => {
  it("embeds the analyses table on a result summary without duplicating its columns in Details", async () => {
    const summary: Entity = {
      ...wafer,
      id: "01900000-0000-7000-8000-000000000009",
      accession: "RS-2026-0001",
      entity_type: "result_summary",
      name: "TLS noise",
      body: "",
      columns: [{ key: "q_i", label: "Qi" }],
    };
    vi.mocked(getRegistry).mockResolvedValue({
      id: summary.id,
      entity_type: "result_summary",
      accession: summary.accession,
      source_key: null,
      version: 1,
      created_at: summary.created_at,
      updated_at: summary.updated_at,
      created_by_id: null,
    });
    vi.mocked(getEntity).mockResolvedValue({ data: summary, etag: '"v1"' });
    vi.mocked(getResultSummaryTable).mockResolvedValue({
      summary: { id: summary.id, accession: summary.accession, name: summary.name, columns: [] },
      keys: ["q_i"],
      columns: [{ key: "q_i", label: "Qi" }],
      rows: [
        {
          analysis: { id: "ar-1", accession: "AR-2026-0001", name: "Fit 1", created_at: summary.created_at },
          project: null,
          experiment: null,
          results: { q_i: 2 },
        },
      ],
    });
    render(
      <MemoryRouter initialEntries={[`/entity/${summary.id}`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const table = await screen.findByRole("table", { name: "Result summary table" });
    expect(within(table).getByRole("link", { name: "Fit 1" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Analyses" })).toBeTruthy();
    // `columns` is an array, so the scalar Details list ignores it.
    expect(screen.queryByText("columns")).toBeNull();
  });

  it("loads registry metadata, entity history, and linked artifacts and notes", async () => {
    render(
      <MemoryRouter initialEntries={[`/entity/${wafer.id}?type=device`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "Science wafer" }),
    ).toBeTruthy();
    expect(getLineageGraph).toHaveBeenCalledWith(wafer.id, {
      direction: "up",
      depth: 5,
      hydrate: true,
    });
    expect(getLineageGraph).toHaveBeenCalledWith(wafer.id, {
      direction: "down",
      depth: 5,
      hydrate: true,
    });
    expect(getLineageGraph).toHaveBeenCalledWith(wafer.id, {
      direction: "both",
      depth: 1,
      relations: ["refers_to", "annotates"],
      hydrate: true,
    });
    expect(getRegistry).toHaveBeenCalledWith(wafer.id);
    expect(getEntityLabel).toHaveBeenCalledWith(wafer.id);
    expect(getEntity).toHaveBeenCalledWith("wafer", wafer.id);
    expect(getEntityEvents).toHaveBeenCalledWith(wafer.id, {
      after: undefined,
      limit: 100,
    });
    expect(getEntityEvents).toHaveBeenCalledWith(wafer.id, {
      after: "2026-07-18T20:00:00Z|event-1",
      limit: 100,
    });
    expect(
      screen.getByTitle("derived from provenance; not an identifier")
        .textContent,
    ).toBe("Science.Wafer");
    const inlineImage = await screen.findByAltText("Wafer map");
    expect(inlineImage.getAttribute("src")).toBe(
      `/api/artifacts/${artifact.id}/download`,
    );
    expect(
      screen.getByRole("heading", { name: "Inspection note" }),
    ).toBeTruthy();
    expect(screen.getByText("created")).toBeTruthy();
    expect(screen.getByText("updated")).toBeTruthy();
  });

  it("keeps entity history visible when related records fail to load", async () => {
    vi.mocked(getLineageGraph).mockImplementation(async (_entityId, query) => {
      if (query?.direction === "both") {
        throw new Error("related graph unavailable");
      }
      return { nodes: [], edges: [] };
    });

    render(
      <MemoryRouter initialEntries={[`/entity/${wafer.id}`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("Related records could not be loaded."),
    ).toBeTruthy();
    expect(screen.getByText("created")).toBeTruthy();
    expect(screen.getByText("updated")).toBeTruthy();
    expect(
      screen.queryByText("No events are visible for this entity."),
    ).toBeNull();
  });
});

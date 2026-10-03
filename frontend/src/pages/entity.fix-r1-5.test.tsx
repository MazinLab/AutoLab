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
  type EdgeRelation,
  type Entity,
} from "../api/client";
import { EntityPage } from "./entity/EntityPage";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getEntity: vi.fn(),
    getEntityEvents: vi.fn(),
    getEntityLabel: vi.fn(),
    getLineageGraph: vi.fn(),
    getPrinters: vi.fn(),
    getRegistry: vi.fn(),
  };
});

const analysisRun: Entity = {
  id: "01900000-0000-7000-8000-000000000010",
  accession: "ANA-2026-0001",
  entity_type: "analysis_run",
  name: "Resonator analysis",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-19T08:00:00Z",
  updated_at: "2026-07-19T08:00:00Z",
  version: 0,
};

const artifact: Entity = {
  ...analysisRun,
  id: "01900000-0000-7000-8000-000000000011",
  accession: "ART-2026-0001",
  entity_type: "artifact",
  name: "IQ sweep",
  media_type: "image/png",
};

const allRelations = new Set<EdgeRelation>([
  "derived_from",
  "supersedes",
  "measured_in",
  "mounted_in",
  "performed_on",
  "produced_by",
  "refers_to",
  "part_of",
  "annotates",
]);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getRegistry).mockResolvedValue({
    id: analysisRun.id,
    entity_type: analysisRun.entity_type,
    accession: analysisRun.accession,
    source_key: analysisRun.source_key,
    version: analysisRun.version,
    created_at: analysisRun.created_at,
    updated_at: analysisRun.updated_at,
    created_by_id: analysisRun.created_by_id,
  });
  vi.mocked(getEntity).mockImplementation(async (entityType) => ({
    data: entityType === "artifact" ? artifact : analysisRun,
    etag: '"v0"',
  }));
  vi.mocked(getEntityEvents).mockResolvedValue({ events: [], next_cursor: null });
  vi.mocked(getEntityLabel).mockResolvedValue("");
  vi.mocked(getPrinters).mockResolvedValue([]);
  vi.mocked(getLineageGraph).mockImplementation(async (_entityId, query) => ({
    nodes:
      query?.direction === "both" && query.relations?.includes("produced_by")
        ? [
            {
              id: artifact.id,
              accession: artifact.accession,
              entity_type: artifact.entity_type,
              depth: 1,
            },
          ]
        : [],
    edges: [],
  }));
});

afterEach(() => {
  cleanup();
});

describe("EntityPage direct related records", () => {
  it("shows an artifact linked to its producer by produced_by", async () => {
    render(
      <MemoryRouter initialEntries={[`/entity/${analysisRun.id}`]}>
        <Routes>
          <Route path="/entity/:id" element={<EntityPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByAltText("IQ sweep")).toBeTruthy();
    expect(getEntity).toHaveBeenCalledWith("artifact", artifact.id);

    const queriedRelations = new Set(
      vi
        .mocked(getLineageGraph)
        .mock.calls.filter(
          ([, query]) => query?.direction === "both" && query.depth === 1,
        )
        .flatMap(([, query]) => query?.relations ?? []),
    );
    expect(queriedRelations).toEqual(allRelations);
  });
});

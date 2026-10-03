import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity } from "../../api/client";
import { AnalysisResults } from "./AnalysisResults";

const apiMocks = vi.hoisted(() => ({
  createEdge: vi.fn(),
  deleteEdge: vi.fn(),
  patchEntity: vi.fn(),
  searchEntities: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, ...apiMocks };
});

const analysis: Entity = {
  id: "ar-1",
  accession: "AR-2026-0001",
  entity_type: "analysis_run",
  name: "Fit 1",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
  version: 3,
  results: { q_i: 1500000, film: "Al/Ti" },
};

beforeEach(() => {
  apiMocks.patchEntity.mockResolvedValue({ data: analysis, etag: '"v4"' });
  apiMocks.createEdge.mockResolvedValue({ id: "e" });
  apiMocks.deleteEdge.mockResolvedValue(undefined);
  apiMocks.searchEntities.mockResolvedValue([
    { id: "rs-1", entity_type: "result_summary", accession: "RS-2026-0001", name: "TLS noise" },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AnalysisResults", () => {
  it("shows the results and saves an edit with If-Match", async () => {
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <AnalysisResults analysis={analysis} canWrite etag={'"v3"'} onChanged={onChanged} summaries={[]} />
      </MemoryRouter>,
    );
    expect(screen.getByText("1.5e+6")).toBeTruthy();
    expect(screen.getByText("Al/Ti")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Edit results" }));
    await userEvent.type(screen.getByLabelText("New result key"), "t_mk");
    await userEvent.type(screen.getByLabelText("New result value"), "100");
    await userEvent.click(screen.getByRole("button", { name: "Add result" }));
    await userEvent.click(screen.getByRole("button", { name: "Save results" }));
    await waitFor(() =>
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "analysis_run",
        "ar-1",
        { results: { q_i: 1500000, film: "Al/Ti", t_mk: 100 } },
        '"v3"',
      ),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  it("lists summaries, joins another by search, and leaves one", async () => {
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <AnalysisResults
          analysis={analysis}
          canWrite
          etag={'"v3"'}
          onChanged={onChanged}
          summaries={[{ id: "rs-0", entity_type: "result_summary", accession: "RS-2026-0000", name: "Qi vs T", depth: 1 }]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: /Qi vs T/ }).getAttribute("href")).toBe("/entity/rs-0");
    await userEvent.type(screen.getByLabelText("Add to summary"), "TLS");
    await userEvent.click(await screen.findByRole("button", { name: /TLS noise/ }));
    await waitFor(() =>
      expect(apiMocks.createEdge).toHaveBeenCalledWith({ src_id: "ar-1", relation: "refers_to", dst_id: "rs-1" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Leave Qi vs T" }));
    await waitFor(() =>
      expect(apiMocks.deleteEdge).toHaveBeenCalledWith({ src_id: "ar-1", relation: "refers_to", dst_id: "rs-0" }),
    );
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});

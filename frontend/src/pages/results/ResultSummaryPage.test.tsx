import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Entity, ResultSummaryTable } from "../../api/client";
import { ResultSummaryPage } from "./ResultSummaryPage";

const apiMocks = vi.hoisted(() => ({
  createEdge: vi.fn(),
  deleteEdge: vi.fn(),
  getResultSummaryTable: vi.fn(),
  getWhoami: vi.fn(),
  patchEntity: vi.fn(),
  searchEntities: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return { ...actual, ...apiMocks };
});

const summary: Entity = {
  id: "rs-1",
  accession: "RS-2026-0001",
  entity_type: "result_summary",
  name: "TLS noise",
  description: "",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
  version: 1,
  body: "",
  columns: [],
};

const table: ResultSummaryTable = {
  summary: { id: "rs-1", accession: "RS-2026-0001", name: "TLS noise", columns: [] },
  keys: ["q_i", "t_mk"],
  columns: [{ key: "q_i", label: "q_i" }, { key: "t_mk", label: "t_mk" }],
  rows: [
    {
      analysis: { id: "ar-1", accession: "AR-2026-0001", name: "Fit 1", created_at: "2026-09-01T10:00:00Z" },
      project: { id: "p-1", accession: "PROJ-2026-0001", name: "Alpha" },
      experiment: { id: "n-1", accession: "NOTE-2026-0001", name: "Cooldown 7" },
      results: { q_i: 1500000, t_mk: 100 },
    },
    {
      analysis: { id: "ar-2", accession: "AR-2026-0002", name: "Fit 2", created_at: "2026-09-02T10:00:00Z" },
      project: { id: "p-2", accession: "PROJ-2026-0002", name: "Beta" },
      experiment: null,
      results: { t_mk: 120 },
    },
  ],
};

function renderPage(onChanged = vi.fn()): void {
  render(
    <MemoryRouter>
      <ResultSummaryPage etag={'"v1"'} onChanged={onChanged} summary={summary} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMocks.getResultSummaryTable.mockResolvedValue(table);
  apiMocks.getWhoami.mockResolvedValue({ login: "x", person: null, mapped: false, can_write: true });
  apiMocks.createEdge.mockResolvedValue({ id: "e" });
  apiMocks.deleteEdge.mockResolvedValue(undefined);
  apiMocks.patchEntity.mockResolvedValue({ data: summary, etag: '"v2"' });
  apiMocks.searchEntities.mockResolvedValue([
    { id: "ar-3", entity_type: "analysis_run", accession: "AR-2026-0003", name: "Fit 3" },
    { id: "w-1", entity_type: "wafer", accession: "W-2026-0001", name: "Not an analysis" },
  ]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ResultSummaryPage", () => {
  it("renders one row per analysis with links and formatted values", async () => {
    renderPage();
    const grid = await screen.findByRole("table", { name: "Result summary table" });
    const rows = within(grid).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByRole("link", { name: "Fit 1" }).getAttribute("href")).toBe("/entity/ar-1");
    expect(within(rows[1]).getByRole("link", { name: "Alpha" }).getAttribute("href")).toBe("/entity/p-1");
    expect(within(rows[1]).getByText("1.5e+6")).toBeTruthy();
    expect(within(rows[2]).getAllByRole("cell")[4].textContent).toBe("");
  });

  it("adds an analysis through search and removes a row", async () => {
    const onChanged = vi.fn();
    renderPage(onChanged);
    await screen.findByRole("table", { name: "Result summary table" });
    await userEvent.type(screen.getByLabelText("Add analysis"), "Fit");
    const option = await screen.findByRole("button", { name: /Fit 3/ });
    expect(screen.queryByText(/Not an analysis/)).toBeNull();
    await userEvent.click(option);
    await waitFor(() =>
      expect(apiMocks.createEdge).toHaveBeenCalledWith({ src_id: "ar-3", relation: "refers_to", dst_id: "rs-1" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Remove Fit 2" }));
    await waitFor(() =>
      expect(apiMocks.deleteEdge).toHaveBeenCalledWith({ src_id: "ar-2", relation: "refers_to", dst_id: "rs-1" }),
    );
    // Membership edges change Related records on the page, so the parent refreshes.
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(2));
  });

  it("saves a reordered, relabeled, filtered column list", async () => {
    apiMocks.getResultSummaryTable.mockResolvedValue({
      ...table,
      keys: ["q_i", "t_mk", "film"],
      columns: [{ key: "q_i", label: "q_i" }, { key: "t_mk", label: "t_mk" }, { key: "film", label: "film" }],
    });
    renderPage();
    await screen.findByRole("table", { name: "Result summary table" });
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    await userEvent.click(screen.getByLabelText("Show film"));
    await userEvent.click(screen.getByLabelText("Move t_mk up"));
    await userEvent.clear(screen.getByLabelText("Label for t_mk"));
    await userEvent.type(screen.getByLabelText("Label for t_mk"), "T (mK)");
    await userEvent.click(screen.getByRole("button", { name: "Save columns" }));
    await waitFor(() =>
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "result_summary",
        "rs-1",
        { columns: [{ key: "t_mk", label: "T (mK)" }, { key: "q_i", label: "" }] },
        '"v1"',
      ),
    );
  });

  it("will not save an empty column list", async () => {
    renderPage();
    await screen.findByRole("table", { name: "Result summary table" });
    await userEvent.click(screen.getByRole("button", { name: "Columns" }));
    await userEvent.click(screen.getByLabelText("Show q_i"));
    await userEvent.click(screen.getByLabelText("Show t_mk"));
    expect((screen.getByRole("button", { name: "Save columns" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("hides editing controls for read-only clients", async () => {
    apiMocks.getWhoami.mockResolvedValue({ login: null, person: null, mapped: false, can_write: false });
    renderPage();
    await screen.findByRole("table", { name: "Result summary table" });
    await waitFor(() => expect(screen.queryByLabelText("Add analysis")).toBeNull());
    expect(screen.queryByRole("button", { name: "Columns" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeTruthy();
  });
});

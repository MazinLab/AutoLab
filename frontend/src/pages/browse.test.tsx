import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getEntity,
  getProjectReport,
  listEntities,
  listEntitiesPage,
  searchEntities,
  type Entity,
} from "../api/client";
import { BrowseListPage } from "./browse/BrowseListPage";
import { BrowsePage } from "./browse/BrowsePage";

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return {
    ...actual,
    getEntity: vi.fn(),
    getProjectReport: vi.fn(),
    listEntities: vi.fn(),
    listEntitiesPage: vi.fn(),
    searchEntities: vi.fn(),
  };
});

const waferOne: Entity = {
  id: "01900000-0000-7000-8000-000000000001",
  accession: "W-2026-0001",
  entity_type: "wafer",
  name: "Zebra wafer",
  description: "First deposition",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 1,
  material: "Nb on Si",
  diameter_mm: 100,
};

const waferTwo: Entity = {
  ...waferOne,
  id: "01900000-0000-7000-8000-000000000002",
  accession: "W-2026-0002",
  name: "Alpha wafer",
  description: "Second deposition",
  updated_at: "2026-07-19T20:00:00Z",
};

function renderListRoute(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/browse/:slug" element={<BrowseListPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listEntities).mockResolvedValue([]);
  vi.mocked(listEntitiesPage).mockResolvedValue({
    rows: [waferTwo, waferOne],
    total: 2,
  });
  vi.mocked(searchEntities).mockResolvedValue([]);
  vi.mocked(getEntity).mockRejectedValue(new Error("not mocked"));
  vi.mocked(getProjectReport).mockRejectedValue(new Error("not mocked"));
});

afterEach(() => {
  cleanup();
});

describe("BrowsePage projects", () => {
  it("lists projects first in the catalog groups and shows open project cards", async () => {
    const active: Entity = {
      ...waferOne,
      id: "project-1",
      accession: "PRJ-2026-0001",
      entity_type: "project",
      name: "Air Bridge MKIDs",
      status: "active",
    };
    const finished: Entity = { ...active, id: "project-2", name: "Old", status: "completed" };
    vi.mocked(listEntities).mockImplementation((type: string) =>
      Promise.resolve(type === "project" ? [finished, active] : []),
    );
    vi.mocked(getProjectReport).mockResolvedValue({
      project: active,
      lead: null,
      goals: [],
      milestones: [],
      progress: {
        goals_done: 0,
        goals_total: 0,
        milestones_done: 2,
        milestones_total: 5,
        overdue_milestones: 0,
      },
      work: {},
      events: [],
    });

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>,
    );

    const card = await screen.findByRole("link", { name: /Air Bridge MKIDs/ });
    expect(card.getAttribute("href")).toBe("/entity/project-1");
    await screen.findByText("2/5 milestones");
    expect(screen.queryByRole("link", { name: /^Old/ })).toBeNull();
    const groups = screen.getAllByRole("heading", { level: 2 });
    const titles = groups.map((heading) => heading.textContent);
    expect(titles.indexOf("Projects")).toBeLessThan(titles.indexOf("Fab"));
  });
});

describe("BrowsePage", () => {
  it("debounces global catalog search", async () => {
    vi.mocked(searchEntities).mockResolvedValue([
      {
        id: waferOne.id,
        accession: waferOne.accession,
        entity_type: "wafer",
        name: waferOne.name,
      },
    ]);
    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>,
    );

    fireEvent.change(screen.getByLabelText("Search names and descriptions"), {
      target: { value: "zebra" },
    });
    expect(searchEntities).not.toHaveBeenCalled();
    await waitFor(() => expect(searchEntities).toHaveBeenCalledWith("zebra", 20));
    expect(await screen.findByRole("link", { name: /Zebra wafer/ })).toBeTruthy();
  });

  it("lists only experiment setups without an end date in the active strip", async () => {
    const running: Entity = {
      ...waferOne,
      id: "01900000-0000-7000-8000-0000000000e1",
      accession: "ES-2026-0001",
      entity_type: "experiment_setup",
      name: "White fridge dark run",
      started_at: "2026-08-05T09:00:00Z",
      ended_at: null,
    };
    const unnamed: Entity = {
      ...running,
      id: "01900000-0000-7000-8000-0000000000e2",
      accession: "ES-2026-0002",
      name: "",
      started_at: "2026-08-01T09:00:00Z",
    };
    const finished: Entity = {
      ...running,
      id: "01900000-0000-7000-8000-0000000000e3",
      accession: "ES-2026-0003",
      name: "Warmed up run",
      ended_at: "2026-08-06T12:00:00Z",
    };
    vi.mocked(listEntities).mockResolvedValue([running, unnamed, finished]);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("region", { name: "Active setups" }),
    ).toBeTruthy();
    expect(listEntities).toHaveBeenCalledWith("experiment_setup", {
      limit: 100,
      order: "desc",
    });

    const strip = screen.getByRole("region", { name: "Active setups" });
    const named = within(strip).getByRole("link", {
      name: /White fridge dark run/,
    });
    expect(named.getAttribute("href")).toBe(`/entity/${running.id}`);
    expect(named.textContent).toContain("ES-2026-0001");
    expect(named.textContent).toContain("since Aug 5");

    // A setup with no name falls back to its accession.
    expect(
      within(strip).getByRole("link", { name: /ES-2026-0002/ }),
    ).toBeTruthy();

    // Ended setups never appear.
    expect(within(strip).queryByText(/Warmed up run/)).toBeNull();
  });

  it("hides the active setups strip entirely when no setup is running", async () => {
    const finished: Entity = {
      ...waferOne,
      id: "01900000-0000-7000-8000-0000000000e4",
      accession: "ES-2026-0004",
      entity_type: "experiment_setup",
      name: "Warmed up run",
      started_at: "2026-08-01T09:00:00Z",
      ended_at: "2026-08-06T12:00:00Z",
    };
    vi.mocked(listEntities).mockResolvedValue([finished]);

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(listEntities).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "Active setups" })).toBeNull();
    expect(screen.queryByText("Active setups")).toBeNull();
  });

  it("hides the active setups strip when the fetch fails", async () => {
    vi.mocked(listEntities).mockRejectedValue(new Error("offline"));

    render(
      <MemoryRouter>
        <BrowsePage />
      </MemoryRouter>,
    );

    await waitFor(() => expect(listEntities).toHaveBeenCalled());
    expect(screen.queryByText("Active setups")).toBeNull();
  });
});

describe("BrowseListPage", () => {
  it("fetches one server page ordered by updated and renders typed columns", async () => {
    renderListRoute("/browse/wafers");

    await screen.findByRole("link", { name: "W-2026-0001" });
    expect(listEntitiesPage).toHaveBeenCalledTimes(1);
    expect(listEntitiesPage).toHaveBeenCalledWith("wafer", {
      limit: 50,
      offset: 0,
      order: "desc",
      orderBy: "updated",
    });
    expect(screen.getByRole("columnheader", { name: "Material" })).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: "Diameter (mm)" }),
    ).toBeTruthy();
    expect(screen.getByText("1–2 of 2")).toBeTruthy();

    // Rows render in server order; the server sorts, not the client.
    const tableBody = screen.getByRole("table").querySelector("tbody");
    const rows = within(tableBody as HTMLTableSectionElement).getAllByRole("row");
    expect(rows[0].textContent).toContain("W-2026-0002");
    expect(rows[0].textContent).toContain("Nb on Si");
    expect(
      within(rows[0])
        .getByRole("link", { name: "Alpha wafer" })
        .getAttribute("href"),
    ).toBe(`/entity/${waferTwo.id}`);

    // Toggling the Updated header flips the server sort order.
    fireEvent.click(screen.getByRole("button", { name: "Updated" }));
    await waitFor(() =>
      expect(listEntitiesPage).toHaveBeenLastCalledWith("wafer", {
        limit: 50,
        offset: 0,
        order: "asc",
        orderBy: "updated",
      }),
    );
  });

  it("debounces the search box into the server q parameter", async () => {
    renderListRoute("/browse/wafers");
    await screen.findByRole("link", { name: "W-2026-0001" });

    vi.mocked(listEntitiesPage).mockResolvedValue({
      rows: [waferOne],
      total: 1,
    });
    fireEvent.change(screen.getByLabelText("Search this list"), {
      target: { value: "First" },
    });
    // The fetch waits for the 300 ms debounce.
    expect(listEntitiesPage).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(listEntitiesPage).toHaveBeenLastCalledWith("wafer", {
        limit: 50,
        offset: 0,
        order: "desc",
        orderBy: "updated",
        q: "First",
      }),
    );
    expect(await screen.findByText("1–1 of 1")).toBeTruthy();
  });

  it("pages forward and backward through server pages", async () => {
    const firstPage = Array.from({ length: 50 }, (_, index): Entity => ({
      ...waferOne,
      id: `bulk-${index}`,
      accession: `W-BULK-${String(index).padStart(4, "0")}`,
      name: `Bulk wafer ${index}`,
    }));
    vi.mocked(listEntitiesPage)
      .mockResolvedValueOnce({ rows: firstPage, total: 120 })
      .mockResolvedValueOnce({ rows: [waferTwo], total: 120 });

    renderListRoute("/browse/wafers");

    await screen.findByRole("link", { name: "W-BULK-0000" });
    expect(screen.getByText("1–50 of 120")).toBeTruthy();
    const previous = screen.getByRole("button", { name: "Previous" });
    expect(previous.hasAttribute("disabled")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("link", { name: "W-2026-0002" });
    expect(listEntitiesPage).toHaveBeenLastCalledWith("wafer", {
      limit: 50,
      offset: 50,
      order: "desc",
      orderBy: "updated",
    });
    expect(screen.getByText("51–51 of 120")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "W-BULK-0000" })).toBeNull();
  });

  it("keeps uncategorized instruments visible in both equipment lists", async () => {
    const fridge: Entity = {
      ...waferOne,
      id: "inst-1",
      accession: "INST-2026-0001",
      entity_type: "instrument",
      name: "White Fridge",
      category: "experimental",
      kind: "Dilution refrigerator",
      location: "Broida 2015",
    };
    const sputter: Entity = {
      ...fridge,
      id: "inst-2",
      accession: "INST-2026-0002",
      name: "Sputter 4",
      category: "fab",
    };
    const legacy: Entity = {
      ...fridge,
      id: "inst-3",
      accession: "INST-2026-0003",
      name: "Uncategorized probe",
      category: "",
    };
    vi.mocked(listEntitiesPage).mockResolvedValue({
      rows: [fridge, sputter, legacy],
      total: 3,
    });

    renderListRoute("/browse/fab-equipment");

    await screen.findByRole("link", { name: "Sputter 4" });
    // No server category filter: equality cannot express "uncategorized OR fab".
    expect(listEntitiesPage).toHaveBeenCalledWith("instrument", {
      limit: 50,
      offset: 0,
      order: "desc",
      orderBy: "updated",
    });
    expect(screen.getByRole("link", { name: "Uncategorized probe" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "White Fridge" })).toBeNull();
    // The pager stays honest about the server-side total vs the list subset.
    expect(
      screen.getByText(/Records 1–3 of 3 instruments; 2 in this list/),
    ).toBeTruthy();
  });

  it("lists testbeds separately from experimental equipment", async () => {
    const fridge: Entity = {
      ...waferOne,
      id: "inst-1",
      accession: "INST-2026-0001",
      entity_type: "instrument",
      name: "White Fridge",
      category: "testbed",
      kind: "dilution_refrigerator",
      location: "Broida 2015",
      base_temp_mk: 12,
    };
    const vna: Entity = {
      ...fridge,
      id: "inst-2",
      accession: "INST-2026-0002",
      name: "VNA",
      category: "experimental",
    };
    vi.mocked(listEntitiesPage).mockResolvedValue({ rows: [fridge, vna], total: 2 });

    renderListRoute("/browse/testbeds");

    await screen.findByRole("link", { name: "White Fridge" });
    expect(screen.queryByRole("link", { name: "VNA" })).toBeNull();
    expect(screen.getByText("12")).toBeTruthy();
  });

  it("narrows a member list to one project from ?project= and shows the chip", async () => {
    vi.mocked(getEntity).mockResolvedValue({
      data: {
        ...waferOne,
        id: "project-1",
        accession: "PRJ-2026-0001",
        entity_type: "project",
        name: "Air Bridge MKIDs",
      },
      etag: null,
    });

    renderListRoute("/browse/wafers?project=project-1");

    await screen.findByRole("link", { name: "Zebra wafer" });
    expect(listEntitiesPage).toHaveBeenCalledWith("wafer", {
      limit: 50,
      offset: 0,
      order: "desc",
      orderBy: "updated",
      filters: { project_id: "project-1" },
    });
    expect(
      (await screen.findByRole("link", { name: "Air Bridge MKIDs" })).getAttribute("href"),
    ).toBe("/entity/project-1");
  });

  it("filters notes to the experiment template on the server", async () => {
    const experiment: Entity = {
      ...waferOne,
      id: "note-1",
      accession: "NOTE-2026-0001",
      entity_type: "note",
      name: "Dark count sweep",
      template: "Experiment",
      body: "## Setup\nCooled to base and swept.",
    };
    vi.mocked(listEntitiesPage).mockResolvedValue({
      rows: [experiment],
      total: 1,
    });

    renderListRoute("/browse/experiments");

    await screen.findByRole("link", { name: "Dark count sweep" });
    // note.template is a typed column, so the subset is a server filter.
    expect(listEntitiesPage).toHaveBeenCalledWith("note", {
      limit: 50,
      offset: 0,
      order: "desc",
      orderBy: "updated",
      filters: { template: "Experiment" },
    });
    // Markdown headers are stripped from the body snippet column.
    expect(screen.getByText(/Setup Cooled to base and swept./)).toBeTruthy();
  });

  it("explains an unknown list slug instead of crashing", () => {
    renderListRoute("/browse/not-a-list");

    expect(screen.getByText("This record list does not exist.")).toBeTruthy();
    expect(listEntitiesPage).not.toHaveBeenCalled();
  });
});

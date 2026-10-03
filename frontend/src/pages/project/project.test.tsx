import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type Entity,
  type ProjectItem,
  type ProjectReport,
} from "../../api/client";
import { ProjectPage, describeProjectEvent, isOverdue } from "./ProjectPage";

const apiMocks = vi.hoisted(() => ({
  createProjectItem: vi.fn(),
  getProjectReport: vi.fn(),
  setProjectItemDone: vi.fn(),
}));

vi.mock("../../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/client")>();
  return {
    ...actual,
    createProjectItem: apiMocks.createProjectItem,
    getProjectReport: apiMocks.getProjectReport,
    setProjectItemDone: apiMocks.setProjectItemDone,
  };
});

const project: Entity = {
  id: "project-1",
  accession: "PRJ-2026-0001",
  entity_type: "project",
  name: "Air Bridge MKIDs",
  description: "Air bridged MKIDs for MEC-II.",
  extra: {},
  source_key: null,
  created_by_id: null,
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-01T10:00:00Z",
  version: 1,
  status: "active",
  lead_id: "person-1",
};

function item(overrides: Partial<ProjectItem>): ProjectItem {
  return {
    id: "item-1",
    project_id: project.id,
    kind: "goal",
    title: "Goal",
    position: 0,
    target_date: null,
    done_at: null,
    done_by_id: null,
    created_at: "2026-09-01T10:00:00Z",
    created_by_id: null,
    ...overrides,
  };
}

const wafer: Entity = {
  ...project,
  id: "wafer-1",
  accession: "W-2026-0004",
  entity_type: "wafer",
  name: "AB wafer 4",
  status: undefined,
};

function emptyWork(): ProjectReport["work"] {
  const keys = [
    "wafer",
    "device",
    "experiment_setup",
    "experiment",
    "analysis_run",
    "design",
    "fab_recipe",
    "substrate_batch",
    "software",
    "result_summary",
    "fab_step",
    "fab_note",
    "measurement_run",
  ];
  return Object.fromEntries(keys.map((key) => [key, { count: 0, recent: [] }]));
}

function report(overrides: Partial<ProjectReport> = {}): ProjectReport {
  return {
    project,
    lead: { ...project, id: "person-1", entity_type: "person", name: "Ben" },
    goals: [item({ id: "goal-1", title: "Demonstrate air bridges" })],
    milestones: [
      item({
        id: "ms-1",
        kind: "milestone",
        title: "First wafer out",
        target_date: "2026-01-01",
      }),
      item({
        id: "ms-2",
        kind: "milestone",
        title: "Cooldown",
        done_at: "2026-08-01T10:00:00Z",
        position: 1,
      }),
    ],
    progress: {
      goals_done: 0,
      goals_total: 1,
      milestones_done: 1,
      milestones_total: 2,
      overdue_milestones: 1,
    },
    work: { ...emptyWork(), wafer: { count: 3, recent: [wafer] } },
    events: [
      {
        id: "event-1",
        at: "2026-09-02T10:00:00Z",
        actor_id: null,
        action: "project_item.done",
        entity_id: project.id,
        payload: { kind: "milestone", title: "Cooldown" },
      },
    ],
    ...overrides,
  };
}

function renderPage(): void {
  render(
    <MemoryRouter>
      <ProjectPage entity={project} etag='"v1"' onChanged={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMocks.getProjectReport.mockReset().mockResolvedValue(report());
  apiMocks.createProjectItem.mockReset();
  apiMocks.setProjectItemDone.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ProjectPage", () => {
  it("renders header, lead, progress, overdue pill, and project-scoped links", async () => {
    renderPage();
    expect(await screen.findByText("1 of 2 milestones done · 1 overdue")).toBeTruthy();
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText("Ben").closest("a")?.getAttribute("href")).toBe(
      "/entity/person-1",
    );
    expect(screen.getByText("Overdue")).toBeTruthy();
    const wafers = screen.getByRole("region", { name: /Wafers/ });
    expect(within(wafers).getByText("See all").getAttribute("href")).toBe(
      "/browse/wafers?project=project-1",
    );
    expect(within(wafers).getByText("+ New").getAttribute("href")).toBe(
      "/new?template=Wafer&project=project-1",
    );
    expect(within(wafers).getByText("AB wafer 4")).toBeTruthy();
    // Zero-count blocks stay hidden.
    expect(screen.queryByRole("region", { name: /Devices/ })).toBeNull();
  });

  it("checks a milestone off through the done endpoint and refetches the report", async () => {
    apiMocks.setProjectItemDone.mockResolvedValue(item({ id: "ms-1" }));
    const user = userEvent.setup();
    renderPage();
    const checkbox = await screen.findByLabelText("Complete First wafer out");
    await user.click(checkbox);
    await waitFor(() =>
      expect(apiMocks.setProjectItemDone).toHaveBeenCalledWith(
        project.id,
        "ms-1",
        true,
      ),
    );
    await waitFor(() => expect(apiMocks.getProjectReport).toHaveBeenCalledTimes(2));
  });

  it("adds a goal from the inline form", async () => {
    apiMocks.createProjectItem.mockResolvedValue(item({ id: "goal-2", title: "Publish" }));
    const user = userEvent.setup();
    renderPage();
    const input = await screen.findByLabelText("New goal");
    await user.type(input, "Publish");
    const goals = screen.getByRole("region", { name: "Goals" });
    await user.click(within(goals).getByRole("button", { name: "Add" }));
    await waitFor(() =>
      expect(apiMocks.createProjectItem).toHaveBeenCalledWith(project.id, {
        kind: "goal",
        title: "Publish",
      }),
    );
  });

  it("offers Add work on an empty project", async () => {
    apiMocks.getProjectReport.mockResolvedValue(
      report({ work: emptyWork(), goals: [], milestones: [], events: [] }),
    );
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText(/No work in this project yet/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Add work" }));
    const nav = screen.getByRole("navigation", { name: "Add work to this project" });
    expect(within(nav).getByText("+ Experiment Setup").getAttribute("href")).toBe(
      "/new?template=Experiment%20Setup&project=project-1",
    );
  });

  it("describes item and membership events readably", () => {
    const base = report();
    expect(describeProjectEvent(base.events[0], base)).toBe(
      "Completed milestone: Cooldown",
    );
    expect(
      describeProjectEvent(
        {
          ...base.events[0],
          action: "project.member_added",
          payload: { accession: "W-2026-0004" },
        },
        base,
      ),
    ).toBe("Added W-2026-0004 to the project");
    expect(
      describeProjectEvent(
        { ...base.events[0], action: "created", entity_id: wafer.id, payload: {} },
        base,
      ),
    ).toBe("AB wafer 4 created");
  });

  it("flags only open, past-due milestones as overdue", () => {
    expect(isOverdue(item({ kind: "milestone", target_date: "2020-01-01" }))).toBe(true);
    expect(
      isOverdue(
        item({ kind: "milestone", target_date: "2020-01-01", done_at: "2020-02-01" }),
      ),
    ).toBe(false);
    expect(isOverdue(item({ kind: "goal", target_date: "2020-01-01" }))).toBe(false);
    expect(isOverdue(item({ kind: "milestone", target_date: "2999-01-01" }))).toBe(false);
  });
  it("lists result summaries that span the project's analyses", async () => {
    apiMocks.getProjectReport.mockResolvedValue(
      report({
        work: {
          ...emptyWork(),
          result_summary: {
            count: 1,
            recent: [
              { ...project, id: "rs-1", accession: "RS-2026-0001", entity_type: "result_summary", name: "TLS noise" },
            ],
          },
        },
      }),
    );
    renderPage();
    const block = await screen.findByRole("region", { name: /Result summaries/ });
    expect(within(block).getByRole("link", { name: /TLS noise/ }).getAttribute("href")).toBe("/entity/rs-1");
    expect(within(block).getByRole("link", { name: "See all" }).getAttribute("href")).toBe("/browse/result-summaries");
  });
});

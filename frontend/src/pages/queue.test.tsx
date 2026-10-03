import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, type Entity } from "../api/client";
import { ReviewQueuePage } from "./queue";

const apiMocks = vi.hoisted(() => ({
  getEntity: vi.fn(),
  getEntityEvents: vi.fn(),
  listEntitiesPage: vi.fn(),
  patchEntity: vi.fn(),
}));

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return {
    ...actual,
    getEntity: apiMocks.getEntity,
    getEntityEvents: apiMocks.getEntityEvents,
    listEntitiesPage: apiMocks.listEntitiesPage,
    patchEntity: apiMocks.patchEntity,
  };
});

const reviewTask: Entity & { kind: string; status: string } = {
  id: "01900000-0000-7000-8000-000000000030",
  accession: "RT-2026-0001",
  entity_type: "review_task",
  name: "Check resonator assignment",
  description: "The automated match is ambiguous.",
  kind: "annotation",
  status: "open",
  extra: {
    evidence_ids: ["01900000-0000-7000-8000-000000000040"],
  },
  source_key: null,
  created_by_id: null,
  created_at: "2026-07-18T20:00:00Z",
  updated_at: "2026-07-18T20:00:00Z",
  version: 3,
};

function renderQueue(): void {
  render(
    <MemoryRouter>
      <ReviewQueuePage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  apiMocks.getEntity.mockReset();
  apiMocks.getEntityEvents.mockReset();
  apiMocks.listEntitiesPage.mockReset();
  apiMocks.patchEntity.mockReset();
  apiMocks.listEntitiesPage.mockResolvedValue({ rows: [reviewTask], total: 1 });
  apiMocks.getEntity.mockResolvedValue({ data: reviewTask, etag: '"v3"' });
  apiMocks.getEntityEvents.mockResolvedValue({ events: [], next_cursor: null });
  apiMocks.patchEntity.mockResolvedValue({
    data: { ...reviewTask, status: "resolved", version: 4 },
    etag: '"v4"',
  });
});

afterEach(() => {
  cleanup();
});

describe("ReviewQueuePage", () => {
  it("lists open tasks server-side, sends the ETag on resolve, then refreshes", async () => {
    apiMocks.listEntitiesPage
      .mockResolvedValueOnce({ rows: [reviewTask], total: 1 })
      // Refresh after the decision: the queue is now clear.
      .mockResolvedValueOnce({ rows: [], total: 0 });
    const user = userEvent.setup();
    renderQueue();

    expect(await screen.findByText("Check resonator assignment")).toBeTruthy();
    // One filtered server page — never a full review-task download.
    expect(apiMocks.listEntitiesPage).toHaveBeenCalledWith("review_task", {
      filters: { status: "open" },
      limit: 50,
      offset: 0,
      order: "desc",
    });
    expect(apiMocks.getEntity).toHaveBeenCalledWith(
      "review_task",
      reviewTask.id,
    );
    // Provenance comes from the task's own bounded event stream.
    expect(apiMocks.getEntityEvents).toHaveBeenCalledWith(reviewTask.id, {
      limit: 200,
    });
    // No linked events, so legacy extra.evidence_ids still render.
    expect(
      screen
        .getByRole("link", {
          name: "01900000-0000-7000-8000-000000000040",
        })
        .getAttribute("href"),
    ).toBe("/entity/01900000-0000-7000-8000-000000000040");
    await user.click(screen.getByRole("button", { name: "Resolve" }));

    await waitFor(() => {
      expect(apiMocks.patchEntity).toHaveBeenCalledWith(
        "review_task",
        reviewTask.id,
        { status: "resolved" },
        '"v3"',
      );
    });
    expect(await screen.findByText("Review task resolved.")).toBeTruthy();
    // The page data is refreshed from the server after the decision.
    expect(await screen.findByText("Queue clear")).toBeTruthy();
    expect(apiMocks.listEntitiesPage).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Check resonator assignment")).toBeNull();
  });

  it("shows the required reload message after a stale dismiss", async () => {
    apiMocks.patchEntity.mockRejectedValue(
      new ApiError(412, "stale entity version"),
    );
    const user = userEvent.setup();
    renderQueue();

    expect(await screen.findByText("Check resonator assignment")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(await screen.findByText("changed elsewhere, reload")).toBeTruthy();
    expect(screen.getByText("Check resonator assignment")).toBeTruthy();
  });

  it("does not display a task that closed between list and detail fetch", async () => {
    apiMocks.getEntity.mockResolvedValue({
      data: { ...reviewTask, status: "resolved", version: 4 },
      etag: '"v4"',
    });
    renderQueue();

    expect(await screen.findByText("Queue clear")).toBeTruthy();
    expect(screen.queryByText("Check resonator assignment")).toBeNull();
  });

  it("pages through open tasks with Prev/Next controls", async () => {
    const openTasks = Array.from({ length: 50 }, (_, index) => ({
      ...reviewTask,
      id: `01900000-0000-7000-8000-${String(index + 1).padStart(12, "0")}`,
      accession: `RT-2026-${String(index + 1).padStart(4, "0")}`,
      name: `Review task ${index + 1}`,
    }));
    const lastTask = {
      ...reviewTask,
      id: "01900000-0000-7000-8000-000000000051",
      accession: "RT-2026-0051",
      name: "Review task 51",
    };
    apiMocks.listEntitiesPage
      .mockResolvedValueOnce({ rows: openTasks, total: 51 })
      .mockResolvedValueOnce({ rows: [lastTask], total: 51 });
    apiMocks.getEntity.mockImplementation(
      (_type: string, id: string) =>
        Promise.resolve({
          data: openTasks.find((task) => task.id === id) ?? lastTask,
          etag: '"v3"',
        }),
    );
    const user = userEvent.setup();
    renderQueue();

    expect(await screen.findByText("Review task 1")).toBeTruthy();
    expect(screen.getByText(/1–50 of 51 open tasks/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("Review task 51")).toBeTruthy();
    expect(apiMocks.listEntitiesPage).toHaveBeenLastCalledWith("review_task", {
      filters: { status: "open" },
      limit: 50,
      offset: 50,
      order: "desc",
    });
    expect(screen.getByText(/51–51 of 51 open tasks/)).toBeTruthy();
  });
});
